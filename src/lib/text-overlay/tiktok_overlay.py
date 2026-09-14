#!/usr/bin/env python3
"""Add adjustable TikTok Sans text to slides. Requires Pillow; no network calls."""
import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
PRESET = json.loads((HERE / "preset.json").read_text())
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}


def finite_number(value, name, minimum, maximum):
    value = float(value)
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name}: допустимо от {minimum} до {maximum}")
    return value


def make_overlay(size, text, font_size=None, size_scale=1, y=50, x=50,
                 max_width=90, line_height=None, stroke=None):
    """Return RGBA overlay + actual bounds. x/y are block-center percentages.

    font_size and stroke use actual image pixels; omitted values follow preset.
    line_height is a multiplier of font_size. Long lines wrap automatically.
    """
    width, height = size
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Текст пустой")
    x = finite_number(x, "x", 0, 100)
    y = finite_number(y, "y", 0, 100)
    max_width = finite_number(max_width, "max_width", 1, 100)
    size_scale = finite_number(size_scale, "size_scale", .05, 10)
    default_size = PRESET["font_size_per_1170"] * width / 1170
    fs = finite_number(font_size if font_size is not None else default_size,
                       "font_size", 1, 2000) * size_scale
    if fs > 2000:
        raise ValueError("Итоговый размер шрифта больше 2000 px")
    relative_scale = fs / PRESET["font_size_per_1170"]
    outline = finite_number(stroke if stroke is not None else
                            PRESET["stroke_per_1170"] * relative_scale,
                            "stroke", 0, 100)
    leading = finite_number(line_height if line_height is not None else
                            PRESET["line_step_per_1170"] / PRESET["font_size_per_1170"],
                            "line_height", 1, 4)
    ss = 4
    font = ImageFont.truetype(str(HERE / PRESET["font"]), round(fs * ss))
    tracking = PRESET["tracking_per_1170"] * relative_scale * ss
    extra_space = PRESET["extra_word_space_per_1170"] * relative_scale * ss
    radius = round(outline * ss)

    def layout(line):
        cursor = 0
        placements = []
        for i, char in enumerate(line):
            placements.append((char, cursor))
            cursor += (font.getlength(line[i:i+2]) - font.getlength(line[i+1:i+2])
                       + tracking + (extra_space if char == " " else 0))
        return placements, max(0, cursor - tracking) if line else 0

    available = width * max_width / 100 * ss - radius * 2 - 4 * ss
    if available <= 0:
        raise ValueError("Недостаточная ширина для текста и обводки")
    lines = []
    # Preserve manual paragraph breaks, normalize repeated whitespace within lines.
    for paragraph in text.replace("\\n", "\n").split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue
        current = ""
        for word in paragraph.split():
            candidate = current + (" " if current else "") + word
            if layout(candidate)[1] <= available:
                current = candidate
                continue
            if current:
                lines.append(current)
                current = ""
            for char in word:
                if layout(char)[1] > available:
                    raise ValueError("Одна буква шире доступной строки: уменьшите --font-size")
                if current and layout(current + char)[1] > available:
                    lines.append(current)
                    current = ""
                current += char
        lines.append(current)
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    if len(lines) * fs * leading > height + fs:
        raise ValueError("Слишком много строк: уменьшите размер текста")
    layouts = [layout(line) for line in lines]
    step = fs * leading * ss
    pad = math.ceil((outline + fs * .35 + 4) * ss)
    canvas_width = math.ceil(max(length for _, length in layouts)) + 2 * pad
    canvas_height = math.ceil((len(lines) - 1) * step + fs * ss * 2) + 2 * pad
    if canvas_width * canvas_height > 32_000_000:
        raise ValueError("Text layer is too large; reduce font size or text length")
    fill = Image.new("L", (canvas_width, canvas_height))
    edge = Image.new("L", fill.size)
    draw_fill, draw_edge = ImageDraw.Draw(fill), ImageDraw.Draw(edge)
    for row, (placements, length) in enumerate(layouts):
        for char, pos in placements:
            point = ((canvas_width - length) / 2 + pos, pad + row * step)
            draw_fill.text(point, char, font=font, fill=255, anchor="la")
            draw_edge.text(point, char, font=font, fill=255, stroke_width=radius,
                           stroke_fill=255, anchor="la")
    bounds = edge.getbbox()
    if bounds is None:
        raise ValueError("Не удалось отрисовать текст")
    # Keep room for antialiasing at the outer contour.
    bounds = (max(0, bounds[0]-ss*2), max(0, bounds[1]-ss*2),
              min(edge.width, bounds[2]+ss*2), min(edge.height, bounds[3]+ss*2))
    fill, edge = fill.crop(bounds), edge.crop(bounds)
    patch = Image.new("RGBA", edge.size, PRESET["stroke"])
    patch.putalpha(edge)
    white = Image.new("RGBA", fill.size, PRESET["fill"])
    white.putalpha(fill)
    patch = Image.alpha_composite(patch, white)
    patch = patch.resize((math.ceil(patch.width/ss), math.ceil(patch.height/ss)),
                         Image.Resampling.LANCZOS)
    left = round(width*x/100-patch.width/2)
    top = round(height*y/100-patch.height/2)
    if left < 0 or top < 0 or left+patch.width > width or top+patch.height > height:
        raise ValueError("Текст выходит за края: измените --y/--x, уменьшите --font-size "
                         "или --max-width")
    result = Image.new("RGBA", size)
    result.paste(patch, (left, top))
    return result, {"font_size_px": round(fs, 3), "stroke_px": round(outline, 3),
                    "lines": lines, "center_percent": [x, y],
                    "bounds": [left, top, left+patch.width, top+patch.height]}


def render_slide(source, output, text, transparent=False, overwrite=False, **options):
    source, output = Path(source).resolve(), Path(output).resolve()
    overlay_path = output.with_name(output.stem + "-overlay.png")
    targets = [output] + ([overlay_path] if transparent else [])
    if output.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("Результат должен быть .png, .jpg или .webp")
    for target in targets:
        if target == source:
            raise ValueError("Исходный слайд нельзя перезаписывать; укажите новый путь")
        if target.exists() and not overwrite:
            raise ValueError(f"Файл уже существует: {target}. Используйте --overwrite")
    with Image.open(source) as opened:
        icc = opened.info.get("icc_profile")
        base = ImageOps.exif_transpose(opened).convert("RGBA")
    layer, info = make_overlay(base.size, text, **options)
    result = Image.alpha_composite(base, layer)
    output.parent.mkdir(parents=True, exist_ok=True)
    save_options = {"icc_profile": icc} if icc else {}
    if output.suffix.lower() in {".jpg", ".jpeg"}:
        result.convert("RGB").save(output, quality=95, subsampling=0, **save_options)
    elif output.suffix.lower() == ".webp":
        result.save(output, lossless=True, **save_options)
    else:
        result.save(output, **save_options)
    if transparent:
        layer.save(overlay_path)
    return {"input": str(source), "output": str(output), **info}


def main():
    parser = argparse.ArgumentParser(description="Текст TikTok Sans на слайдах")
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--input", type=Path, help="Фото или папка с фото")
    inputs.add_argument("--batch", type=Path, help="JSON со своим текстом для каждого слайда")
    text_group = parser.add_mutually_exclusive_group()
    text_group.add_argument("--text", help="Текст; \\n — перенос строки")
    text_group.add_argument("--text-file", type=Path, help="Текст из UTF-8 файла")
    parser.add_argument("--output", type=Path, help="Итоговое фото")
    parser.add_argument("--output-dir", type=Path, help="Папка результатов")
    parser.add_argument("--font-size", type=float, help="Размер в пикселях итогового фото")
    parser.add_argument("--size-scale", type=float, default=1, help="Множитель размера, например 1.2")
    parser.add_argument("--y", type=float, default=50, help="Высота центра блока, %% от верхнего края")
    parser.add_argument("--x", type=float, default=50, help="Горизонтальный центр блока, %%")
    parser.add_argument("--max-width", type=float, default=90, help="Ширина текстового блока, %% фото")
    parser.add_argument("--line-height", type=float, help="Межстрочный интервал: множитель размера")
    parser.add_argument("--stroke", type=float, help="Толщина обводки в пикселях")
    parser.add_argument("--transparent", action="store_true", help="Также сохранить прозрачный PNG текста")
    parser.add_argument("--overwrite", action="store_true", help="Заменять существующие результаты")
    args = parser.parse_args()
    keys = ("font_size", "size_scale", "y", "x", "max_width", "line_height", "stroke")
    defaults = {key: getattr(args, key) for key in keys}
    try:
        if args.batch:
            if args.text is not None or args.text_file or args.output:
                raise ValueError("--batch использует тексты и пути из JSON")
            items = json.loads(args.batch.read_text(encoding="utf-8"))
            if not isinstance(items, list) or not items:
                raise ValueError("JSON должен содержать непустой список слайдов")
            root = args.batch.resolve().parent
            jobs = []
            for item in items:
                if not isinstance(item, dict) or not {"input", "text"} <= item.keys():
                    raise ValueError("Каждому слайду нужны input и text")
                unknown = set(item) - {"input", "output", "text", *keys}
                if unknown:
                    raise ValueError(f"Неизвестные настройки JSON: {sorted(unknown)}")
                source = root / item["input"]
                output = (root / item["output"] if item.get("output") else
                          (args.output_dir or root / "rendered") / (source.stem + ".png"))
                jobs.append((source, output, item["text"],
                             {**defaults, **{k: item[k] for k in keys if k in item}}))
        else:
            text = args.text_file.read_text(encoding="utf-8") if args.text_file else args.text
            if text is None:
                raise ValueError("Укажите --text или --text-file")
            if args.input.is_dir():
                if args.output:
                    raise ValueError("Для папки используйте --output-dir")
                destination = args.output_dir or args.input / "rendered"
                files = sorted(p for p in args.input.iterdir() if p.suffix.lower() in IMAGE_EXTENSIONS)
                if not files:
                    raise ValueError("В папке нет поддерживаемых фото")
                jobs = [(f, destination / (f.stem + ".png"), text, defaults) for f in files]
            else:
                output = args.output or ((args.output_dir or args.input.parent) /
                                         (args.input.stem + "-text.png"))
                jobs = [(args.input, output, text, defaults)]
        sources = {source.resolve() for source, _, _, _ in jobs}
        destinations = []
        for _, output, _, _ in jobs:
            destinations.append(output.resolve())
            if args.transparent:
                destinations.append(output.with_name(output.stem+"-overlay.png").resolve())
        if len(set(destinations)) != len(destinations) or sources & set(destinations):
            raise ValueError("Пути результатов конфликтуют между собой или с исходниками")
        if not args.overwrite:
            for destination in destinations:
                if destination.exists():
                    raise ValueError(f"Результат уже существует: {destination}")
        for source, output, text, options in jobs:
            result = render_slide(source, output, text, args.transparent, args.overwrite, **options)
            print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError) as exc:
        parser.exit(2, f"Ошибка: {exc}\n")


if __name__ == "__main__":
    main()
