#!/usr/bin/env python3
"""JwtProvider.issueAccessToken 과 같은 HS256 access 토큰을 민트한다.

bcrypt cost 12 로그인 1,000회를 피하려고 벤치 시드가 SQL로 사용자를 넣은 뒤
이 스크립트로 JWT만 발급한다. 클레임은 sub(userId) + role 뿐이다.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import sys
import time


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def mint(user_id: int, secret: str, role: str, ttl_sec: int) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"typ": "JWT", "alg": "HS256"}, separators=(",", ":")).encode())
    payload = b64url(
        json.dumps(
            {"sub": str(user_id), "role": role, "iat": now, "exp": now + ttl_sec},
            separators=(",", ":"),
        ).encode()
    )
    sig = hmac.new(secret.encode("utf-8"), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--secret", required=True)
    p.add_argument("--role", default="USER")
    p.add_argument("--ttl", type=int, default=3600)
    args = p.parse_args()
    ids = [int(line.strip()) for line in sys.stdin if line.strip()]
    for uid in ids:
        print(mint(uid, args.secret, args.role, args.ttl))


if __name__ == "__main__":
    main()
