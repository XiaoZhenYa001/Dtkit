//! Placement and bounded image encoding for the long-capture side preview.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PreviewRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Find a monitor area wholly outside the selected region. The preview never
/// relies on capture exclusion flags, which can vary between capture APIs.
pub(crate) fn preview_placement(
    selection: PreviewRect,
    monitors: &[PreviewRect],
    vertical: bool,
) -> Option<PreviewRect> {
    const GAP: i64 = 8;
    let sx = i64::from(selection.x);
    let sy = i64::from(selection.y);
    let sr = sx + i64::from(selection.width);
    let sb = sy + i64::from(selection.height);
    let (desired_w, desired_h) = if vertical { (240, 360) } else { (360, 200) };
    let directions = if vertical { [0, 1, 2, 3] } else { [2, 3, 0, 1] };
    let mut best = None;
    for (priority, side) in directions.into_iter().enumerate() {
        for monitor in monitors {
            let mx = i64::from(monitor.x);
            let my = i64::from(monitor.y);
            let mr = mx + i64::from(monitor.width);
            let mb = my + i64::from(monitor.height);
            let (left, top, right, bottom) = match side {
                0 => (mx, my, mr.min(sx - GAP), mb),
                1 => (mx.max(sr + GAP), my, mr, mb),
                2 => (mx, my, mr, mb.min(sy - GAP)),
                _ => (mx, my.max(sb + GAP), mr, mb),
            };
            let width = (right - left).min(desired_w);
            let height = (bottom - top).min(desired_h);
            if width < 120 || height < 100 { continue; }
            let x = ((sx + sr - width) / 2).clamp(left, right - width);
            let y = ((sy + sb - height) / 2).clamp(top, bottom - height);
            let Ok(x) = i32::try_from(x) else { continue };
            let Ok(y) = i32::try_from(y) else { continue };
            let rect = PreviewRect { x, y, width: width as u32, height: height as u32 };
            // Prefer a full-size preview on the conventional side, but choose
            // another monitor or side when it can show considerably more.
            let score = width * height * 10 - priority as i64;
            if best.as_ref().is_none_or(|(best_score, _)| score > *best_score) {
                best = Some((score, rect));
            }
        }
    }
    best.map(|(_, rect)| rect)
}

/// Downsample directly from the stitched pixel buffer; no full-size copy is
/// needed. The result stays bounded even for the largest allowed screenshot.
#[cfg(target_os = "windows")]
pub(crate) fn preview_data_url(width: u32, height: u32, pixels: &[u8]) -> Result<String, String> {
    use base64::Engine;
    use std::io::Cursor;
    if width == 0 || height == 0
        || (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4)) != Some(pixels.len())
    {
        return Err("长截图预览图像尺寸无效".into());
    }
    let scale = (320.0 / f64::from(width)).min(1200.0 / f64::from(height)).min(1.0);
    let out_width = (f64::from(width) * scale).round().max(1.0) as u32;
    let out_height = (f64::from(height) * scale).round().max(1.0) as u32;
    let mut out = image::RgbaImage::new(out_width, out_height);
    for y in 0..out_height {
        let src_y = (u64::from(y) * u64::from(height) / u64::from(out_height)) as usize;
        for x in 0..out_width {
            let src_x = (u64::from(x) * u64::from(width) / u64::from(out_width)) as usize;
            let index = (src_y * width as usize + src_x) * 4;
            out.put_pixel(x, y, image::Rgba([pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]]));
        }
    }
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(out).write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| format!("编码长截图预览失败：{error}"))?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intersects(a: PreviewRect, b: PreviewRect) -> bool {
        i64::from(a.x) < i64::from(b.x) + i64::from(b.width)
            && i64::from(b.x) < i64::from(a.x) + i64::from(a.width)
            && i64::from(a.y) < i64::from(b.y) + i64::from(b.height)
            && i64::from(b.y) < i64::from(a.y) + i64::from(a.height)
    }

    #[test]
    fn preview_stays_on_screen_and_outside_selection_for_both_directions() {
        let monitor = PreviewRect { x: -1920, y: -100, width: 1920, height: 1080 };
        let selection = PreviewRect { x: -1500, y: 100, width: 1000, height: 600 };
        for vertical in [true, false] {
            let result = preview_placement(selection, &[monitor], vertical).unwrap();
            assert!(!intersects(selection, result));
            assert!(result.x >= monitor.x && result.y >= monitor.y);
            assert!(i64::from(result.x) + i64::from(result.width) <= i64::from(monitor.x) + i64::from(monitor.width));
            assert!(i64::from(result.y) + i64::from(result.height) <= i64::from(monitor.y) + i64::from(monitor.height));
        }
    }

    #[test]
    fn full_screen_has_no_preview_but_an_adjacent_monitor_can_host_it() {
        let selection = PreviewRect { x: 0, y: 0, width: 1920, height: 1080 };
        assert_eq!(preview_placement(selection, &[selection], true), None);
        let adjacent = PreviewRect { x: 1920, y: 0, width: 1920, height: 1080 };
        let result = preview_placement(selection, &[selection, adjacent], true).unwrap();
        assert!(!intersects(selection, result));
        assert!(result.x >= adjacent.x);
    }

    #[test]
    fn rejects_spaces_that_are_too_small() {
        let monitor = PreviewRect { x: 0, y: 0, width: 300, height: 300 };
        let selection = PreviewRect { x: 50, y: 50, width: 200, height: 200 };
        assert!(preview_placement(selection, &[monitor], true).is_none());
    }
}
