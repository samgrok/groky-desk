#!/usr/bin/env python3
"""Génère data/state.json pour le Groky Desk à partir des fichiers du box.

Sources lues (toutes optionnelles, rien n'est inventé : champ absent => null) :
  /workspace/trading/positions.json      positions ouvertes (liste)
  /workspace/trading/journal.csv         journal des trades
  /workspace/trading/last_scan.json      dernier scan de Groky (si la routine l'écrit)
                                         {"at": "...", "tokens_scanned": n, "passed": n,
                                          "rejections": {"raison": n, ...}, "candidates": [...]}
  /workspace/trading/agents.json         statut manuel par agent (si écrit)
                                         {"groky": {"status": "...", "last_action": "...", "at": "..."}, ...}
  /workspace/radar/state.json            état de Radar (signaux, dernier scan, wallets suivis)
  /workspace/radar/copytrade_journal.json  copy-trades détectés (gr3g)
  /workspace/garde/state.json            verdicts de Garde (si existe) {"verdicts":[...], "last_action":..., "at":...}
  /workspace/stratege/state.json         notes du Stratège (si existe) {"last_action":..., "at":..., "notes":[...]}

Le secret HELIUS_API_KEY (variable d'environnement) sert UNIQUEMENT ici, côté box,
pour lister les comptes de tokens du wallet. Seules des adresses publiques sont écrites
dans state.json. La clé n'est jamais écrite sur disque.

Usage : python3 /workspace/groky-desk/build_state.py
"""
import csv, hashlib, json, os, sys, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "state.json")
TR = "/workspace/trading"
RD = "/workspace/radar"

WALLET = "4sPACuXcJ3ssYURkuyxHDUsDh39WpEdreDxus2B969rB"
BASELINE = {"sol": 1.527, "usd": 109.5, "at": "2026-11-16T18:30:00+01:00"}
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
RULES = {
    "position_usd": 15, "max_positions": 3, "reserve_sol": 0.02,
    "stop_loss_pct": -20, "take_profit_mult": 1.5, "take_profit_sell_pct": 50,
    "trailing_stop_pct": -20, "max_slippage_pct": 3,
    "filters": {"min_liquidity_usd": 500000, "min_age_h": 12, "min_volume_1h_usd": 50000,
                "mint_freeze_revoked": True, "max_change_1h_pct": 100, "max_holder_pct": 15},
    "scan_every_min": 15,
    "signals": ["MOMENTUM", "DIP", "COPY-TRADE"],
}

# ---------- utilitaires ----------
def load_json(p, default=None):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return default

def to_iso(v):
    """Normalise une date (ISO, 'YYYY-MM-DD HH:MM[:SS]' heure de Paris, ou epoch) en ISO avec offset."""
    if v in (None, ""):
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v, PARIS).isoformat(timespec="seconds")
        s = str(v).strip().replace(" Europe/Paris", "")
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            d = datetime.fromisoformat(s)
        except ValueError:
            d = datetime.strptime(s[:16], "%Y-%m-%d %H:%M")
        if d.tzinfo is None:
            d = d.replace(tzinfo=PARIS)
        return d.astimezone(PARIS).isoformat(timespec="seconds")
    except Exception:
        return None

def num(v):
    try:
        if v in (None, ""):
            return None
        return float(v)
    except Exception:
        return None

def pick(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return None

# ---------- base58 + dérivation des ATA (adresses publiques) ----------
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return (b"\0" * pad + b).rjust(32, b"\0")[-32:] if len(s) >= 32 else b"\0" * pad + b

def b58e(b):
    n = int.from_bytes(b, "big"); s = ""
    while n:
        n, r = divmod(n, 58); s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s

_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
def on_curve(b):
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    if y >= _P:
        return False
    u = (y * y - 1) % _P
    v = (_D * y * y + 1) % _P
    x2 = u * pow(v, _P - 2, _P) % _P
    return x2 == 0 or pow(x2, (_P - 1) // 2, _P) == 1

def find_pda(seeds, program):
    pid = b58d(program)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + pid + b"ProgramDerivedAddress").digest()
        if not on_curve(h):
            return b58e(h)
    raise ValueError("pas de PDA")

def ata(owner, mint, token_program=TOKEN_PROGRAM):
    return find_pda([b58d(owner), b58d(token_program), b58d(mint)], ATA_PROGRAM)

# ---------- comptes de tokens via Helius (optionnel, clé jamais écrite) ----------
def helius_token_accounts():
    key = os.environ.get("HELIUS_API_KEY")
    if not key:
        return None
    url = "https://mainnet.helius-rpc.com/?api-key=" + key
    out = []
    for prog in (TOKEN_PROGRAM, TOKEN_2022):
        body = {"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
                "params": [WALLET, {"programId": prog}, {"encoding": "jsonParsed"}]}
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json"})
            res = json.load(urllib.request.urlopen(req, timeout=20)).get("result", {})
        except Exception as e:
            print("Helius indisponible :", type(e).__name__, file=sys.stderr)
            return None
        for a in res.get("value", []):
            info = a["account"]["data"]["parsed"]["info"]
            out.append({"account": a["pubkey"], "mint": info["mint"], "program": prog,
                        "ui_amount": info["tokenAmount"].get("uiAmount")})
    return out

# ---------- données ----------
def load_positions():
    raw = load_json(os.path.join(TR, "positions.json"), [])
    if isinstance(raw, dict):
        raw = raw.get("positions", list(raw.values()))
    out = []
    for p in raw or []:
        if not isinstance(p, dict):
            continue
        entry = num(pick(p, "entry_price_usd", "entry_price", "price_usd", "buy_price"))
        out.append({
            "symbol": pick(p, "symbol", "token", "sym", "name"),
            "mint": pick(p, "mint", "address", "token_address"),
            "opened_at": to_iso(pick(p, "opened_at", "date", "entry_time", "time")),
            "entry_price_usd": entry,
            "entry_usd": num(pick(p, "entry_usd", "value_usd", "cost_usd", "size_usd")),
            "entry_sol": num(pick(p, "entry_sol", "amount_sol", "sol")),
            "amount_tokens": num(pick(p, "amount_tokens", "tokens", "qty", "amount")),
            "peak_price_usd": num(pick(p, "peak_price_usd", "peak_price", "high", "peak")),
            "half_sold": bool(pick(p, "half_sold", "tp1_done", "partial_sold")),
            "signal": pick(p, "signal", "reason", "source"),
            "pair_url": pick(p, "pair_url", "url"),
        })
    return out

def load_journal():
    rows = []
    try:
        with open(os.path.join(TR, "journal.csv"), newline="") as f:
            for r in csv.DictReader(f):
                rows.append({
                    "date": to_iso(r.get("date")), "action": (r.get("action") or "").strip() or None,
                    "token": r.get("token") or None, "mint": r.get("mint") or None,
                    "amount_sol": num(r.get("amount_sol")), "price_usd": num(r.get("price_usd")),
                    "value_usd": num(r.get("value_usd")), "signature": r.get("signature") or None,
                    "reason": r.get("reason") or None,
                })
    except FileNotFoundError:
        pass
    rows.sort(key=lambda r: r["date"] or "", reverse=True)
    return rows

def stats(journal, positions):
    open_mints = {p["mint"] for p in positions}
    per = {}
    for r in journal:
        if not r["mint"] or r["value_usd"] is None:
            continue
        a = (r["action"] or "").lower()
        d = per.setdefault(r["mint"], {"buy": 0.0, "sell": 0.0})
        if a.startswith(("buy", "achat")):
            d["buy"] += r["value_usd"]
        elif a.startswith(("sell", "vente", "stop", "tp", "trailing")):
            d["sell"] += r["value_usd"]
    closed = {m: d for m, d in per.items() if m not in open_mints and d["buy"] > 0}
    wins = sum(1 for d in closed.values() if d["sell"] > d["buy"])
    return {
        "trades": len(journal),
        "closed": len(closed), "wins": wins, "losses": len(closed) - wins,
        "win_rate": round(100 * wins / len(closed), 1) if closed else None,
        "realized_pnl_usd": round(sum(d["sell"] - d["buy"] for d in closed.values()), 2) if closed else None,
    }

def minutes_ago(iso):
    if not iso:
        return None
    return (datetime.now(PARIS) - datetime.fromisoformat(iso)).total_seconds() / 60

def status_of(iso, active_min=20):
    m = minutes_ago(iso)
    if m is None:
        return "inconnu"
    return "actif" if m <= active_min else "en veille"

def main():
    now = datetime.now(PARIS)
    positions = load_positions()
    journal = load_journal()
    radar = load_json(os.path.join(RD, "state.json"), {}) or {}
    ct_journal = load_json(os.path.join(RD, "copytrade_journal.json"), []) or []
    last_scan_raw = load_json(os.path.join(TR, "last_scan.json"))
    manual = load_json(os.path.join(TR, "agents.json"), {}) or {}
    garde = load_json("/workspace/garde/state.json", {}) or {}
    strat = load_json("/workspace/stratege/state.json", {}) or {}

    last_scan = None
    if isinstance(last_scan_raw, dict):
        last_scan = {
            "at": to_iso(pick(last_scan_raw, "at", "time", "date")),
            "tokens_scanned": pick(last_scan_raw, "tokens_scanned", "scanned", "n_tokens"),
            "passed": pick(last_scan_raw, "passed", "n_passed"),
            "rejections": last_scan_raw.get("rejections") or {},
            "candidates": last_scan_raw.get("candidates") or [],
            "note": last_scan_raw.get("note"),
        }

    # signaux
    signals = []
    for s in radar.get("signals_sent", []) or []:
        signals.append({"from": "Radar", "type": s.get("type"), "symbol": s.get("symbol"),
                        "mint": s.get("mint"), "at": to_iso(pick(s, "sent_at_paris", "at")),
                        "to": s.get("to"), "verdict": s.get("verdict")})
    for c in ct_journal if isinstance(ct_journal, list) else []:
        signals.append({"from": "Radar", "type": "COPY-TRADE", "symbol": pick(c, "symbol", "token"),
                        "mint": pick(c, "mint"), "at": to_iso(pick(c, "t", "at", "time")),
                        "to": "Garde", "wallet": pick(c, "name", "wallet"), "detail": pick(c, "detail", "side")})
    for v in garde.get("verdicts", []) or []:
        signals.append({"from": "Garde", "type": pick(v, "type", "signal"), "symbol": v.get("symbol"),
                        "mint": v.get("mint"), "at": to_iso(pick(v, "at", "time")),
                        "verdict": pick(v, "verdict", "decision"), "detail": pick(v, "reason", "detail")})
    signals.sort(key=lambda s: s["at"] or "", reverse=True)

    # agents (uniquement des faits ; sinon null => « — » côté site)
    radar_last_sig = next((s for s in signals if s["from"] == "Radar"), None)
    radar_at = to_iso(radar.get("last_scan_paris"))
    radar_action = None
    if radar_at:
        radar_action = "Scan X + suivi " + ", ".join(w.get("name", "?") for w in radar.get("tracked_wallets", []) or []) if radar.get("tracked_wallets") else "Scan des signaux"
    if radar_last_sig and (not radar_at or (radar_last_sig["at"] or "") > radar_at):
        radar_at = radar_last_sig["at"]
        radar_action = f"Signal {radar_last_sig['type']} {radar_last_sig['symbol'] or ''}".strip()

    last_trade = journal[0] if journal else None
    if last_trade:
        g_action = f"{last_trade['action']} {last_trade['token'] or ''}".strip()
        g_at = last_trade["date"]
    else:
        g_action, g_at = ("Aucun trade pour l'instant", None)
    if last_scan and last_scan["at"] and (not g_at or last_scan["at"] > g_at):
        n = last_scan.get("tokens_scanned")
        g_action = f"Scan : {n} tokens, {last_scan.get('passed') or 0} retenu(s)" if n is not None else "Scan du marché"
        g_at = last_scan["at"]

    garde_last = next((s for s in signals if s["from"] == "Garde"), None)
    agents = {
        "groky": {"name": "Groky", "role": "Exécute les trades · scan /15 min",
                  "last_action": g_action, "at": g_at},
        "radar": {"name": "Radar", "role": "Veille X, signaux, copy-trade gr3g",
                  "last_action": radar_action, "at": radar_at,
                  "detail": f"Dernier signal : {radar_last_sig['type']} {radar_last_sig['symbol']} ({radar_last_sig['at'][11:16]})" if radar_last_sig and radar_last_sig.get("at") else None},
        "garde": {"name": "Garde", "role": "Analyse de risque, valide les signaux",
                  "last_action": pick(garde, "last_action") or (f"Verdict {garde_last['verdict']} sur {garde_last['symbol']}" if garde_last else None),
                  "at": to_iso(pick(garde, "at")) or (garde_last["at"] if garde_last else None)},
        "stratege": {"name": "Stratège", "role": "Performance, revue hebdo",
                     "last_action": pick(strat, "last_action"), "at": to_iso(pick(strat, "at"))},
    }
    for k, v in manual.items():
        if k in agents and isinstance(v, dict):
            agents[k].update({kk: (to_iso(vv) if kk == "at" else vv) for kk, vv in v.items() if vv not in (None, "")})
    for a in agents.values():
        a.setdefault("status", None)
        if not a.get("status"):
            a["status"] = status_of(a.get("at"))

    # comptes de tokens (adresses publiques) pour la lecture live sans RPC indexé
    accounts = helius_token_accounts()
    source = "helius" if accounts is not None else "derived"
    if accounts is None:
        accounts = []
    known = {a["mint"] for a in accounts}
    for p in positions:
        if p["mint"] and p["mint"] not in known:
            accounts.append({"account": ata(WALLET, p["mint"]), "mint": p["mint"], "program": TOKEN_PROGRAM, "ui_amount": None})
            known.add(p["mint"])

    state = {
        "generated_at": now.isoformat(timespec="seconds"),
        "wallet": WALLET,
        "baseline": BASELINE,
        "rules": RULES,
        "positions": positions,
        "journal": journal[:200],
        "stats": stats(journal, positions),
        "last_scan": last_scan,
        "agents": agents,
        "signals": signals[:50],
        "tracked_wallets": [{"name": w.get("name"), "address": w.get("address")} for w in radar.get("tracked_wallets", []) or []],
        "token_accounts": [{"account": a["account"], "mint": a["mint"], "program": a["program"]} for a in accounts],
        "token_accounts_source": source,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    print(f"OK {OUT} · {len(positions)} position(s), {len(journal)} trade(s), {len(signals)} signal(aux), {len(accounts)} compte(s) token [{source}]")

if __name__ == "__main__":
    main()
