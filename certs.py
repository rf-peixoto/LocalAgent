"""Self-signed HTTPS certificate for the local network (needs: pip install cryptography).

Browsers only allow the microphone (and the modern clipboard API) on HTTPS or localhost.
A self-signed certificate makes the browser warn once per device; for no warnings at all,
create a certificate with mkcert and point ssl_cert/ssl_key in config.json at it.
"""
import datetime
import ipaddress
import os
import socket
from pathlib import Path


def local_addresses():
    names, ips = {"localhost", socket.gethostname()}, {"127.0.0.1"}
    try:   # the address used for the LAN (no packet is actually sent)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            addr = info[4][0]
            if ":" not in addr:
                ips.add(addr)
    except OSError:
        pass
    return sorted(names), sorted(ips)


def ensure_self_signed(folder: Path):
    """Return (cert_path, key_path), creating them if missing."""
    cert_path, key_path = folder / "server.crt", folder / "server.key"
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
    except ImportError as exc:
        raise RuntimeError("HTTPS needs the 'cryptography' package: pip install cryptography") from exc
    folder.mkdir(parents=True, exist_ok=True)
    names, ips = local_addresses()
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "LOCAL//GRID")])
    now = datetime.datetime.now(datetime.timezone.utc)
    san = [x509.DNSName(n) for n in names] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=825))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print(f"Created a self-signed certificate for: {', '.join(names + ips)}")
    print("If this machine's IP address changes, delete the certs/ folder to regenerate it.")
    return cert_path, key_path
