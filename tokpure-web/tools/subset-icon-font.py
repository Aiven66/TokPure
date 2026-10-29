#!/usr/bin/env python3
"""
Material Symbols 图标字体子集化。

字体把「图标名 → 字形」实现为 GSUB 连字（liga）：只要页面里保留了 a-z/0-9/_，
pyftsubset 的闭包就会把所有图标的连字规则都保留下来，字体几乎不变小。
因此这里先裁掉「本项目没用到」的连字规则，再按文本子集化。

用法：
  python3.11 tools/subset-icon-font.py <src.woff2> <icons.txt> <out.woff2>
"""
import sys
from fontTools.ttLib import TTFont
from fontTools import subset

GLYPH_TEXT = {}
for ch in 'abcdefghijklmnopqrstuvwxyz':
    GLYPH_TEXT[ch] = ch
for d, w in zip('0123456789', ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']):
    GLYPH_TEXT['digit_' + w] = d
GLYPH_TEXT['underscore'] = '_'


def glyph_to_text(g):
    if g in GLYPH_TEXT:
        return GLYPH_TEXT[g]
    return ''


def main(src, icons_file, out):
    names = {n.strip() for n in open(icons_file, encoding='utf-8').read().split() if n.strip()}
    font = TTFont(src)
    gsub = font['GSUB'].table

    kept = 0
    dropped = 0
    found = set()
    for lookup in gsub.LookupList.Lookup:
        if lookup.LookupType != 7:
            continue
        for st in lookup.SubTable:
            inner = getattr(st, 'ExtSubTable', None)
            if inner is None or inner.LookupType != 4:
                continue
            for first in list(inner.ligatures.keys()):
                keep = []
                for lig in inner.ligatures[first]:
                    text = glyph_to_text(first) + ''.join(glyph_to_text(c) for c in lig.Component)
                    if text in names:
                        keep.append(lig)
                        found.add(text)
                        kept += 1
                    else:
                        dropped += 1
                if keep:
                    inner.ligatures[first] = keep
                else:
                    del inner.ligatures[first]

    missing = sorted(names - found)
    print(f'连字规则保留 {kept} / 丢弃 {dropped}；未在字体中找到的图标名 {len(missing)}')
    if missing:
        print('  缺失：' + ' '.join(missing[:40]))

    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    options.name_IDs = ['*']
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables = ['STAT']
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=''.join(names))
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(out)
    print(f'已输出 {out}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
