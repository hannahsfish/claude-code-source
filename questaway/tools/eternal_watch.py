#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QuestAway 永恒装备 Steam 市场监控。

用法：
    python eternal_watch.py            每 300 秒检查一次，一直运行
    python eternal_watch.py 180        每 180 秒检查一次（最低 120，再快会被 Steam 限流）
    python eternal_watch.py once       只检查一次就退出
    python eternal_watch.py 600 all    连法阵护符、符文一起监控（请求更多，间隔要更长）

只用到 Python 自带的库。第一次运行会记录当前挂单作为基准，之后有新挂单、下架、
价格或数量变化时打印出来并响铃。快照保存在脚本同目录的 eternal_snapshot.json，
变化记录追加到 eternal_log.txt。
价格是 Steam 搜索接口返回的美元标价，实际付款以登录后的页面为准。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

APPID = 5195600
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "eternal_snapshot.json")
LOG = os.path.join(HERE, "eternal_log.txt")
UA = "questaway-eternal-watch/1.0 (personal price monitor)"

# 关注的底材：名字里包含左边的词就打上右边的标记。
WANT = [
    ("Scythe of Curses", "诅咒之镰｜★★★ 女巫武器"),
    ("Cursed Lantern", "诅咒提灯｜★★★ 女巫副手"),
    ("Spark Signet", "火花印戒｜★★★ 女巫戒指（法系，带冷却）"),
    ("Sash of Focus", "专注腰带｜★★★ 女巫腰带（冷却+混沌抗性）"),
    ("Arcane Leggings", "奥术护腿｜★★ 女巫护腿（混沌抗性，竞技场）"),
    ("Sage Vestment", "贤者长袍｜★★ 女巫护甲（混沌抗性，竞技场）"),
    ("Mystic Circlet", "秘法头环｜★★ 女巫头盔（混沌抗性，竞技场）"),
    ("Humming Droplet", "嗡鸣水滴｜★★ 女巫耳环（法系，带冷却）"),
    ("Channeler Gloves", "导能手套｜★ 女巫手套（冷却+施法）"),
    ("Wayfarer Boots", "旅人靴｜★ 女巫鞋子"),
    ("Sentinel Seal", "哨兵印戒｜✗ 防御戒指，女巫不要；刺客戒指 2 可用"),
    ("Hammered Hoop", "锻纹耳环｜✗ 重型耳环，女巫不要；刺客可用"),
    ("Windward Gauntlet", "迎风护手｜武僧副手"),
    ("Stalker Jerkin", "潜行者皮甲｜中甲护甲（刺客/弓箭手）"),
    ("Windstep Boots", "风行靴｜中甲鞋子（刺客/弓箭手）"),
    ("Talisman of the Echoing", "护符：暴击率"),
    ("Talisman of the Riven", "护符：暴击伤害"),
    ("Talisman of the Ember", "护符：金币"),
    ("Talisman of the Swooping", "护符：移速"),
]


def tag(name):
    for key, note in WANT:
        if key in name:
            return "  ← " + note
    return ""


def fetch(everything=False):
    """返回 {名字: [美元标价, 挂单数, 类型]}。接口每页最多 10 条。

    默认只查装备（名字形如 "Eternal xxx (Lv 80)"），约 2 次请求；
    everything=True 时连护符和符文一起查，约 5 次请求。
    """
    items, start, total = {}, 0, None
    while total is None or start < total:
        q = urllib.parse.urlencode({
            "query": "Eternal" if everything else "Eternal (Lv", "start": start, "count": 100, "search_descriptions": 0,
            "sort_column": "name", "sort_dir": "asc", "appid": APPID, "norender": 1,
        })
        req = urllib.request.Request("https://steamcommunity.com/market/search/render/?" + q,
                                     headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=40) as r:
            d = json.loads(r.read().decode("utf-8"))
        if not d.get("success"):
            raise RuntimeError("Steam 返回失败")
        total = d.get("total_count", 0)
        res = d.get("results") or []
        if not res:
            break
        for x in res:
            name = x["hash_name"]
            if "Eternal" not in name:
                continue
            items[name] = [x["sell_price"] / 100.0, x["sell_listings"],
                           (x.get("asset_description") or {}).get("type", "")]
        start += len(res)
        time.sleep(3)
    if total and len(items) < total * 0.8:
        raise RuntimeError("结果不完整（%d/%d），可能被限流" % (len(items), total))
    return items


def diff(old, new):
    out = []
    for n in sorted(new):
        p, c, t = new[n]
        if n not in old:
            out.append("【新挂单】%s  $%.2f ×%d  %s%s" % (n, p, c, t, tag(n)))
        else:
            op, oc = old[n][0], old[n][1]
            if abs(p - op) >= 0.005:
                out.append("【价格】%s  $%.2f → $%.2f（%+.0f%%） ×%d%s" % (n, op, p, (p / op - 1) * 100 if op else 0, c, tag(n)))
            elif c != oc:
                out.append("【数量】%s  ×%d → ×%d  $%.2f%s" % (n, oc, c, p, tag(n)))
    for n in sorted(old):
        if n not in new:
            out.append("【下架/售出】%s  原价 $%.2f%s" % (n, old[n][0], tag(n)))
    return out


def beep():
    try:
        import winsound
        winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
    except Exception:
        sys.stdout.write("\a")
        sys.stdout.flush()


def check_once(everything=False):
    new = fetch(everything)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    if not os.path.exists(SNAP):
        with open(SNAP, "w", encoding="utf-8") as f:
            json.dump(new, f, ensure_ascii=False, indent=1)
        print("[%s] 已记录基准：%d 个永恒挂单。" % (stamp, len(new)))
        for n in sorted(new, key=lambda k: new[k][0]):
            if tag(n):
                print("   $%8.2f ×%-2d %s%s" % (new[n][0], new[n][1], n, tag(n)))
        return []
    with open(SNAP, encoding="utf-8") as f:
        old = json.load(f)
    if not everything:  # 只比较装备，快照里的护符、符文原样保留
        keep = {n: v for n, v in old.items() if "(Lv" not in n}
        old = {n: v for n, v in old.items() if "(Lv" in n}
        new_full = dict(keep); new_full.update(new)
    else:
        new_full = new
    changes = diff(old, new)
    if changes:
        with open(SNAP, "w", encoding="utf-8") as f:
            json.dump(new_full, f, ensure_ascii=False, indent=1)
        with open(LOG, "a", encoding="utf-8") as f:
            for c in changes:
                f.write("%s %s\n" % (stamp, c))
        print("[%s] %d 处变化：" % (stamp, len(changes)))
        for c in changes:
            print("   " + c)
        beep()
    else:
        print("[%s] 无变化（%d 个挂单）" % (stamp, len(new)))
    return changes


def safe_check(everything):
    try:
        return check_once(everything)
    except KeyboardInterrupt:
        raise
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print("[%s] 被 Steam 限流（429），这一轮跳过。" % time.strftime("%H:%M:%S"))
        else:
            print("[%s] 检查失败：HTTP %s" % (time.strftime("%H:%M:%S"), e.code))
    except Exception as e:  # 网络错误：等下一轮
        print("[%s] 检查失败：%s" % (time.strftime("%H:%M:%S"), e))
    return None


def main():
    args = sys.argv[1:]
    everything = "all" in args
    args = [a for a in args if a != "all"]
    arg = args[0] if args else "300"
    if arg == "once":
        if safe_check(everything) is None:
            sys.exit(2)
        return
    wait = max(120, int(arg))
    print("每 %d 秒检查一次%s，按 Ctrl+C 停止。" % (wait, "（含护符和符文）" if everything else "（只看装备）"))
    while True:
        safe_check(everything)
        time.sleep(wait)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止。")
