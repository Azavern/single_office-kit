#!/usr/bin/env python3
"""Minimal DNS forwarder for the Single Office tunnel kit (agent-kit).

Listens on 127.0.0.1:53 (UDP) and serves exactly the lookups that the
VM's system resolver refuses, so cloudflared can discover its edge:

  SRV _v2-origintunneld._tcp.argotunnel.com
      -> 1 1 7844 region1.v2.argotunnel.com.
         2 1 7844 region2.v2.argotunnel.com.
  SRV _origintunneld._tcp.argotunnel.com
      -> 1 1 7844 region1.argotunnel.com.
         2 1 7844 region2.argotunnel.com.

Everything else is FORWARDED verbatim to the system resolver
(198.19.0.1, fallback fd8b:4f84:7d32:99::1) and the reply is relayed
unchanged. The system resolver already answers A queries for the
edge hosts (region1/region2.v2.argotunnel.com, cfd-features) with
synthetic proxy IPs, so those are NOT overridden — only the SRV
records, which the resolver REFUSEs, are answered locally.

VM NETWORK QUIRKS (verified 2026-11-16 — read this before touching
the socket code):
  * Unconnected UDP sends are BLOCKED: `sendto()`/`sendmsg()` return
    EPERM for Python, Node and even C programs, while `dig` and Go's
    resolver work. A CONNECTED UDP socket (`connect()` then `send()`)
    works fine.
  * A reply must come FROM the port the client queried (53), or a
    connected client (Go's resolver, socat, dig) drops it as coming
    from the wrong peer. So the server replies from its LISTENING
    socket: recvfrom, connect(client), send, then close + re-bind
    (disconnecting with connect(('0.0.0.0', 0)) is ALSO blocked, so
    the socket is closed and a fresh one bound instead). A query
    arriving in the microsecond re-bind window is lost and the
    client retries — DNS clients do.
  * Upstream queries likewise go out on sockets connected to the
    upstream first.

Fail-open by design:
  * a query this server cannot answer is forwarded, never dropped;
  * if the upstream fails or times out, the client gets SERVFAIL
    (a proper DNS error, not a hang) so it can retry or fall back;
  * the server never writes to the VM's global DNS — it only serves
    processes that point at it (cloudflared runs in a private mount
    namespace with an over-mounted /etc/resolv.conf, see
    run-cloudflared.sh). If this server dies, only cloudflared loses
    DNS; the rest of the VM is untouched.

Records were resolved from the AWS VPS (which has working DNS) on
2026-11-16. Edge IPs rotate; refresh them from the VPS if the tunnel
stops connecting (see RUNBOOK.md tunnel section). The SRV targets are
hostnames, so their A records are resolved fresh per connection.

Usage:
  dns-forwarder.py [--host 127.0.0.1] [--port 53]
                   [--upstream 198.19.0.1] [--upstream2 fd8b:4f84:7d32:99::1]
                   [--pid-file PATH] [--quiet]
Stdlib only. No secrets, no state, no network access except UDP
DNS to the upstreams.
"""
import argparse
import os
import signal
import socket
import struct
import sys
import time

# --- Static SRV answers (targets are hostnames; their A records are
# resolved by the client through the normal path). Priority 1 =
# region1 (preferred), priority 2 = region2.
SRV_ANSWERS = {
    "_v2-origintunneld._tcp.argotunnel.com": [
        (1, 1, 7844, "region1.v2.argotunnel.com"),
        (2, 1, 7844, "region2.v2.argotunnel.com"),
    ],
    "_origintunneld._tcp.argotunnel.com": [
        (1, 1, 7844, "region1.argotunnel.com"),
        (2, 1, 7844, "region2.argotunnel.com"),
    ],
}
SRV_TTL = 60

UPSTREAM_TIMEOUT = 5.0


def log(msg, quiet=False):
    if quiet:
        return
    sys.stderr.write(
        "[%s] dns-forwarder: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    )
    sys.stderr.flush()


def encode_name(name):
    """Encode a dotted hostname into DNS wire format."""
    out = b""
    for label in name.rstrip(".").split("."):
        b = label.encode("ascii")
        out += struct.pack("!B", len(b)) + b
    return out + b"\x00"


def decode_name(data, off):
    """Decode a (possibly compressed) name at offset off.
    Returns (name, next_offset)."""
    labels = []
    jumped = False
    next_off = off
    while True:
        if off >= len(data):
            raise ValueError("name overruns packet")
        ln = data[off]
        if ln == 0:
            off += 1
            if not jumped:
                next_off = off
            break
        if ln & 0xC0 == 0xC0:
            if off + 1 >= len(data):
                raise ValueError("bad compression pointer")
            ptr = ((ln & 0x3F) << 8) | data[off + 1]
            if not jumped:
                next_off = off + 2
            off = ptr
            jumped = True
            continue
        off += 1
        if off + ln > len(data):
            raise ValueError("label overruns packet")
        labels.append(data[off:off + ln].decode("ascii", "replace"))
        off += ln
    return ".".join(labels), next_off


def parse_query(data):
    """Parse a DNS query. Returns (txid, qname, qtype, qclass)."""
    if len(data) < 12:
        raise ValueError("packet too short")
    txid, flags, qdcount, _, _, _ = struct.unpack("!HHHHHH", data[:12])
    if qdcount != 1:
        raise ValueError("qdcount != 1")
    qname, off = decode_name(data, 12)
    if off + 4 > len(data):
        raise ValueError("question truncated")
    qtype, qclass = struct.unpack("!HH", data[off:off + 4])
    return txid, qname, qtype, qclass


def build_response(txid, qname, qtype, qclass, answers, rcode=0):
    """Build a response with the given answer RRs.
    Each answer is (name, rtype, rclass, ttl, rdata_bytes)."""
    flags = 0x8180 | rcode  # QR=1, RD copied as 1, RA=1, RCODE
    header = struct.pack("!HHHHHH", txid, flags, 1, len(answers), 0, 0)
    question = encode_name(qname) + struct.pack("!HH", qtype, qclass)
    body = b""
    for name, rtype, rclass, ttl, rdata in answers:
        body += encode_name(name) + struct.pack("!HHIH", rtype, rclass, ttl, len(rdata)) + rdata
    return header + question + body


def srv_rdata(priority, weight, port, target):
    return struct.pack("!HHH", priority, weight, port) + encode_name(target)


def send_connected(host, port, payload, timeout, quiet=False):
    """Send payload over a CONNECTED UDP socket and return the reply.
    Returns None on failure. (Unconnected sendto is blocked in this
    VM — see the module docstring.)"""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        s = socket.socket(family, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            s.send(payload)
            return s.recv(4096)
        finally:
            s.close()
    except (OSError, socket.timeout) as exc:
        log("udp to %s:%d failed: %s" % (host, port, exc), quiet)
        return None


def forward(query_data, upstreams, quiet=False, verbose=False):
    """Forward the raw query to the first upstream that answers.
    Returns the raw response bytes, or None if all upstreams fail."""
    for host in upstreams:
        resp = send_connected(host, 53, query_data, UPSTREAM_TIMEOUT, quiet)
        if resp is not None:
            if verbose:
                log("forward -> %s: %d bytes" % (host, len(resp)), quiet)
            return resp
    return None


def handle(data, addr, upstreams, quiet=False, verbose=False):
    """Handle one query datagram from addr. Returns the response bytes
    (or None if the query is malformed and must be dropped)."""
    try:
        txid, qname, qtype, qclass = parse_query(data)
    except ValueError as exc:
        log("dropping malformed query from %s: %s" % (addr, exc), quiet)
        return None
    lname = qname.lower()
    if verbose:
        log("query %s type %d from %s" % (qname, qtype, addr), quiet)
    # SRV override: the only queries the system resolver refuses.
    if qtype == 33 and lname in SRV_ANSWERS:  # 33 = SRV
        answers = [
            (qname, 33, qclass, SRV_TTL, srv_rdata(p, w, port, tgt))
            for (p, w, port, tgt) in SRV_ANSWERS[lname]
        ]
        log("SRV %s -> %d record(s)" % (qname, len(answers)), quiet)
        return build_response(txid, qname, qtype, qclass, answers)
    # Everything else: forward verbatim, relay the reply verbatim.
    resp = forward(data, upstreams, quiet, verbose)
    if resp is None:
        log("SERVFAIL %s type %d (all upstreams down)" % (qname, qtype), quiet)
        return build_response(txid, qname, qtype, qclass, [], rcode=2)
    return resp


def bind_socket(host, port):
    """Create + bind the listening socket. Retries briefly: the port
    is re-bound after every reply (see main), so a transient
    'address in use' must not kill the server."""
    last = None
    for _ in range(50):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.bind((host, port))
            s.settimeout(1.0)
            return s
        except OSError as exc:
            last = exc
            try:
                s.close()
            except Exception:
                pass
            time.sleep(0.1)
    raise last


def main():
    ap = argparse.ArgumentParser(description="DNS forwarder for the Single Office tunnel kit")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=53)
    ap.add_argument("--upstream", default="198.19.0.1")
    ap.add_argument("--upstream2", default="fd8b:4f84:7d32:99::1")
    ap.add_argument("--pid-file", default="")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--verbose", action="store_true", help="log every query + forward outcome")
    args = ap.parse_args()

    upstreams = [u for u in (args.upstream, args.upstream2) if u]
    try:
        sock = bind_socket(args.host, args.port)
    except OSError as exc:
        sys.stderr.write("dns-forwarder: cannot bind %s:%d: %s\n" % (args.host, args.port, exc))
        return 1
    if args.pid_file:
        with open(args.pid_file, "w") as f:
            f.write(str(os.getpid()))
    log("listening on %s:%d, upstreams %s" % (args.host, args.port, ", ".join(upstreams)), args.quiet)
    log("overriding SRV: %s" % ", ".join(sorted(SRV_ANSWERS)), args.quiet)

    stop = False

    def _sig(_signum, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)
    while not stop:
        try:
            data, addr = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError as exc:
            log("recv error: %s" % exc, args.quiet)
            # Re-bind defensively; a dead socket must not kill us.
            try:
                sock.close()
            except Exception:
                pass
            try:
                sock = bind_socket(args.host, args.port)
            except OSError as exc2:
                log("re-bind failed: %s" % exc2, args.quiet)
                return 1
            continue
        try:
            resp = handle(data, addr, upstreams, args.quiet, args.verbose)
        except Exception as exc:  # never die on one bad packet
            log("handler error: %s" % exc, args.quiet)
            resp = None
        if resp is None:
            continue
        # Reply FROM the listening socket (source port = the queried
        # port) — a connected client drops replies from any other
        # port. connect() then send(); then close + re-bind, because
        # disconnecting is blocked in this VM (see module docstring).
        try:
            sock.connect(addr)
            sock.send(resp)
        except OSError as exc:
            log("reply to %s failed: %s" % (addr, exc), args.quiet)
        try:
            sock.close()
        except Exception:
            pass
        if stop:
            break
        try:
            sock = bind_socket(args.host, args.port)
        except OSError as exc:
            log("re-bind failed: %s" % exc, args.quiet)
            return 1
    log("shutting down", args.quiet)
    if args.pid_file:
        try:
            os.unlink(args.pid_file)
        except OSError:
            pass
    try:
        sock.close()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
