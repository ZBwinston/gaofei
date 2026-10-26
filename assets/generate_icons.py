#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 PWA 图标：墨色底 + 香槟金 ¥。运行：python assets/generate_icons.py"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
GOLD_TOP = (238, 215, 178)
GOLD_BOTTOM = (195, 154, 99)
BG_TOP = (35, 37, 44)
BG_BOTTOM = (16, 17, 22)


def gradient(size: int, top, bottom) -> Image.Image:
    image = Image.new('RGB', (size, size), top)
    draw = ImageDraw.Draw(image)
    for y in range(size):
        ratio = y / max(size - 1, 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color)
    return image


def glyph_points(size: int, scale: float = 1.0):
    """在 size 画布上按比例放大的 ¥ 笔画（保持视觉居中）。"""
    cx = size / 2
    unit = size * scale
    left = cx - unit * 0.2
    right = cx + unit * 0.2
    top_y = size * 0.5 - unit * 0.24
    mid_y = size * 0.5 - unit * 0.04
    stem_bottom = size * 0.5 + unit * 0.26
    bar1 = size * 0.5 + unit * 0.055
    bar2 = size * 0.5 + unit * 0.145
    return {
        'diag_left': [(left, top_y), (cx, mid_y)],
        'diag_right': [(right, top_y), (cx, mid_y)],
        'stem': [(cx, mid_y - size * 0.005), (cx, stem_bottom)],
        'bar1': [(left + unit * 0.03, bar1), (right - unit * 0.03, bar1)],
        'bar2': [(left + unit * 0.03, bar2), (right - unit * 0.03, bar2)],
        'width': max(2, int(size * scale * 0.066)),
    }


def draw_glyph(draw: ImageDraw.ImageDraw, size: int, scale: float, color):
    pts = glyph_points(size, scale)
    width = pts['width']
    for key in ('diag_left', 'diag_right', 'stem', 'bar1', 'bar2'):
        start, end = pts[key]
        draw.line([start, end], fill=color, width=width)
        radius = width / 2
        for point in (start, end):
            draw.ellipse(
                [point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius],
                fill=color
            )


def make_icon(size: int, maskable: bool = False, name: str = '') -> str:
    base = gradient(size, BG_TOP, BG_BOTTOM).convert('RGBA')

    # 左上柔光
    sheen = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sheen_draw = ImageDraw.Draw(sheen)
    for radius in range(int(size * 0.9), 0, -4):
        alpha = int(26 * (1 - radius / (size * 0.9)))
        sheen_draw.ellipse(
            [int(size * 0.12) - radius, int(-size * 0.05) - radius, int(size * 0.12) + radius, int(-size * 0.05) + radius],
            fill=(255, 255, 255, max(alpha, 0))
        )
    base = Image.alpha_composite(base, sheen)

    # 金色笔画（带轻微渐变：先画浅金，再叠一层深金到下半部分）
    glyph_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw_glyph(ImageDraw.Draw(glyph_layer), size, 0.62 if maskable else 0.78, GOLD_TOP + (255,))

    gold = gradient(size, GOLD_TOP, GOLD_BOTTOM).convert('RGBA')
    gold.putalpha(glyph_layer.getchannel('A'))
    base = Image.alpha_composite(base, gold)

    if not maskable:
        frame = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(frame).rounded_rectangle(
            [0, 0, size - 1, size - 1],
            radius=int(size * 0.226),
            outline=(255, 255, 255, 26),
            width=max(2, int(size * 0.006))
        )
        base = Image.alpha_composite(base, frame)

    if maskable:
        # 蒙版图标：满幅底色，四周留安全区
        canvas = Image.new('RGBA', (size, size), BG_BOTTOM + (255,))
        canvas.paste(base, (0, 0), base)
        base = canvas
    else:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.226), fill=255)
        clipped = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        clipped.paste(base, (0, 0), mask)
        base = clipped

    target = os.path.join(ASSETS, name)
    base.save(target, 'PNG')
    return target


if __name__ == '__main__':
    print(make_icon(192, name='icon-192.png'))
    print(make_icon(512, name='icon-512.png'))
    print(make_icon(512, maskable=True, name='icon-maskable-512.png'))
