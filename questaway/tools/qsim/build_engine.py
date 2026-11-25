#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从客户端解出来的 index.html 生成模拟器用的 engine.html。

用法：python3 -I build_engine.py <解包后的 index.html> <输出 engine.html>

做两件事，不改游戏逻辑：
  1. 找到引擎的具名导出表（含 GAME_VERSION 的那个对象），在它建好之后挂到 window.__NS。
  2. 找到「估算每秒击杀」的函数（返回 abatesPorSegundo / todosDePe / xpDoExcedente），
     挂到 window.__QA.est2，刷图测量要用。找不到时 __QA 为空，刷图测量不可用，其他测量照常。
混淆后的变量名每个版本都不同，所以按代码结构找，不写死名字。1.1.0、1.1.3 都能用。
"""
import re
import sys


def find_ns(s):
    # 形如：_0xNS={};_0xDEF(_0xNS,{'ABAS_DO_CODEX...':()=>...,'GAME_VERSION':()=>...})
    i = s.find("'GAME_VERSION':()=>")
    if i < 0:
        raise SystemExit("找不到 GAME_VERSION 导出")
    m = None
    for m in re.finditer(r"(_0x[0-9a-f]+)=\{\};(_0x[0-9a-f]+)\(\1,\{", s[:i]):
        pass
    if not m:
        raise SystemExit("找不到导出表的定义")
    start = m.end() - 1          # 指向 '{'
    depth, q, k = 0, None, start
    while k < len(s):
        c = s[k]
        if q:
            if c == "\\":
                k += 2
                continue
            if c == q:
                q = None
        elif c in "'\"`":
            q = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        k += 1
    if s[k + 1] != ")":
        raise SystemExit("导出表的调用没按预期结束")
    return m.group(1), k + 2      # 变量名，插入位置（紧跟在 ')' 后面）


def find_est2(s):
    pat = (r"function (_0x\w+)\((_0x\w+)\)\{let (_0x\w+)=(_0x\w+)\(\2\);for\(;\3\[[^\]]+\]&&(_0x\w+)\(\2\);\)"
           r"\3=\4\(\2\);return\{'abatesPorSegundo'")
    m = re.search(pat, s)
    return m.group(1) if m else None


def main():
    src, out = sys.argv[1], sys.argv[2]
    s = open(src, encoding="utf-8", errors="surrogateescape").read()
    ns, pos = find_ns(s)
    est2 = find_est2(s)
    qa = "{est2:%s}" % est2 if est2 else "{}"
    inj = (",(()=>{try{window.__NS=%s;window.__QA=%s;}catch(e){window.__NSERR=String(e);}})()" % (ns, qa))
    open(out, "w", encoding="utf-8", errors="surrogateescape").write(s[:pos] + inj + s[pos:])
    print("导出表 %s，est2 %s，已写入 %s" % (ns, est2 or "（没找到，刷图测量不可用）", out))


if __name__ == "__main__":
    main()
