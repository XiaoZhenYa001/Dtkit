//! Conservative overlap detection for scrolling screenshots.
//!
//! The matcher is deliberately allowed to reject a usable frame.  Once pixels
//! have been appended an incorrect seam cannot be repaired by a later frame.
//! Search the entire permitted range in both directions, then independently
//! validate the candidate against a denser grid and spatial subregions.

use image::RgbaImage;

#[derive(Clone, Copy)]
struct Axis {
    vertical: bool,
    span: u32,
    across: u32,
}

impl Axis {
    fn new(image: &RgbaImage, vertical: bool) -> Self {
        let (width, height) = image.dimensions();
        Self {
            vertical,
            span: if vertical { height } else { width },
            across: if vertical { width } else { height },
        }
    }

    fn pixel(self, image: &RgbaImage, along: u32, across: u32) -> [u8; 4] {
        if self.vertical {
            image.get_pixel(across, along).0
        } else {
            image.get_pixel(along, across).0
        }
    }
}

fn color_distance(a: [u8; 4], b: [u8; 4]) -> f64 {
    (u32::from(a[0].abs_diff(b[0]))
        + u32::from(a[1].abs_diff(b[1]))
        + u32::from(a[2].abs_diff(b[2]))) as f64
        / 3.0
}

#[derive(Default)]
struct Measurement {
    sum: f64,
    count: u32,
    bad: u32,
    brightness: f64,
    brightness_squared: f64,
}

impl Measurement {
    fn add(&mut self, a: [u8; 4], b: [u8; 4]) {
        let difference = color_distance(a, b);
        self.sum += difference;
        self.bad += u32::from(difference > 18.0);
        self.count += 1;
        let brightness = (f64::from(a[0]) + f64::from(a[1]) + f64::from(a[2])) / 3.0;
        self.brightness += brightness;
        self.brightness_squared += brightness * brightness;
    }
    fn mean(&self) -> f64 {
        self.sum / f64::from(self.count.max(1))
    }
    fn bad_fraction(&self) -> f64 {
        f64::from(self.bad) / f64::from(self.count.max(1))
    }
    fn variance(&self) -> f64 {
        let n = f64::from(self.count.max(1));
        (self.brightness_squared / n - (self.brightness / n).powi(2)).max(0.0)
    }
}

// Use grid cell centres rather than the boundaries, including both sides of
// the overlap.  Different grid sizes are used for search and validation.
fn sample_position(i: u32, count: u32, span: u32) -> u32 {
    (((u64::from(i) * 2 + 1) * u64::from(span)) / (u64::from(count) * 2)) as u32
}

fn measure(
    previous: &RgbaImage,
    next: &RgbaImage,
    axis: Axis,
    overlap: u32,
    along_samples: u32,
    across_samples: u32,
) -> (Measurement, [Measurement; 4]) {
    let mut total = Measurement::default();
    let mut regions: [Measurement; 4] = std::array::from_fn(|_| Measurement::default());
    for i in 0..along_samples {
        let along = sample_position(i, along_samples, overlap);
        for j in 0..across_samples {
            let across = sample_position(j, across_samples, axis.across);
            let a = axis.pixel(previous, axis.span - overlap + along, across);
            let b = axis.pixel(next, along, across);
            total.add(a, b);
            regions[((i * 2 / along_samples) * 2 + j * 2 / across_samples) as usize].add(a, b);
        }
    }
    (total, regions)
}

/// A small, textured strip that does not move at all is likely a fixed header,
/// footer, or sidebar.  It cannot safely be stitched as scrolling content.
fn contains_fixed_strip(previous: &RgbaImage, next: &RgbaImage, axis: Axis) -> bool {
    for (vertical_strip, index, divisions) in [
        (false, 0_u32, 32_u32),
        (false, 31, 32),
        (true, 0, 32),
        (true, 31, 32),
        (false, 0, 8),
        (false, 7, 8),
        (true, 0, 8),
        (true, 7, 8),
    ] {
        let mut sample = Measurement::default();
        for y in 0_u32..64 {
            let along = if vertical_strip {
                sample_position(y, 64, axis.span)
            } else {
                ((u64::from(index * 64 + y) * 2 + 1) * u64::from(axis.span)
                    / u64::from(divisions * 128)) as u32
            };
            for x in 0_u32..64 {
                let across = if vertical_strip {
                    ((u64::from(index * 64 + x) * 2 + 1) * u64::from(axis.across)
                        / u64::from(divisions * 128)) as u32
                } else {
                    sample_position(x, 64, axis.across)
                };
                sample.add(
                    axis.pixel(previous, along, across),
                    axis.pixel(next, along, across),
                );
            }
        }
        if sample.mean() < 0.5 && sample.variance() > 100.0 {
            return true;
        }
    }
    false
}

struct Candidate {
    overlap: u32,
    error: f64,
}

// Prefer columns (or rows for a horizontal capture) that contain actual
// detail. A uniformly spaced grid can miss narrow text on a large white page
// and declare a number of incorrect offsets equally perfect.
fn detailed_coordinates(previous: &RgbaImage, next: &RgbaImage, axis: Axis) -> Vec<u32> {
    let count = axis.across.min(128);
    let mut ranked: Vec<(u32, f64)> = (0..count)
        .map(|i| {
            let cross = sample_position(i, count, axis.across);
            let mut a = Measurement::default();
            let mut b = Measurement::default();
            for j in 0..128 {
                let pos = sample_position(j, 128, axis.span);
                let pixel_a = axis.pixel(previous, pos, cross);
                let pixel_b = axis.pixel(next, pos, cross);
                a.add(pixel_a, pixel_a);
                b.add(pixel_b, pixel_b);
            }
            (cross, a.variance().max(b.variance()))
        })
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked.truncate(ranked.len().min(48));
    ranked.into_iter().map(|entry| entry.0).collect()
}

fn search(
    previous: &RgbaImage,
    next: &RgbaImage,
    axis: Axis,
    min_overlap: u32,
    max_overlap: u32,
    across_positions: &[u32],
) -> Vec<Candidate> {
    (min_overlap..=max_overlap)
        .map(|overlap| {
            let mut measurement = Measurement::default();
            for i in 0..72 {
                let along = sample_position(i, 72, overlap);
                for &across in across_positions {
                    measurement.add(
                        axis.pixel(previous, axis.span - overlap + along, across),
                        axis.pixel(next, along, across),
                    );
                }
            }
            Candidate {
                overlap,
                error: measurement.mean(),
            }
        })
        .collect()
}

/// Returns the number of matching pixels along the scrolling axis, only when
/// the seam is unique, forward-moving and consistent across the whole image.
pub(super) fn reliable_overlap(
    previous: &RgbaImage,
    next: &RgbaImage,
    vertical: bool,
) -> Option<u32> {
    if previous.dimensions() != next.dimensions() {
        return None;
    }
    let axis = Axis::new(previous, vertical);
    if axis.span < 32 || axis.across < 16 {
        return None;
    }
    let min_overlap = (axis.span / 5).max(16);
    // A movement of at least 2 pixels makes direction and frame changes visible.
    let max_overlap = axis.span - 2;
    if min_overlap > max_overlap || contains_fixed_strip(previous, next, axis) {
        return None;
    }
    let across_positions = detailed_coordinates(previous, next, axis);
    let mut forward = search(
        previous,
        next,
        axis,
        min_overlap,
        max_overlap,
        &across_positions,
    );
    forward.sort_by(|a, b| a.error.total_cmp(&b.error));
    let best = forward.first()?;
    let alternatives = forward
        .iter()
        .filter(|candidate| candidate.overlap.abs_diff(best.overlap) > 3);
    let second = alternatives
        .map(|candidate| candidate.error)
        .fold(f64::INFINITY, f64::min);
    // Repeated textures and weak/flat areas are not enough evidence of a seam.
    if best.error > 6.0 || second < best.error + 1.5 {
        return None;
    }
    let reverse = search(
        next,
        previous,
        axis,
        min_overlap,
        max_overlap,
        &across_positions,
    )
    .into_iter()
    .map(|candidate| candidate.error)
    .fold(f64::INFINITY, f64::min);
    if reverse < best.error + 1.5 {
        return None;
    }
    let (full, regions) = measure(
        previous,
        next,
        axis,
        best.overlap,
        best.overlap,
        axis.across,
    );
    if full.mean() > 2.0 || full.bad_fraction() > 0.01 || full.variance() < 16.0 {
        return None;
    }
    if regions
        .iter()
        .any(|region| region.mean() > 4.0 || region.bad_fraction() > 0.025)
    {
        return None;
    }
    Some(best.overlap)
}

#[cfg(test)]
mod tests {
    use super::reliable_overlap;
    use image::{Rgba, RgbaImage};

    fn image(vertical: bool, offset: u32) -> RgbaImage {
        let (width, height) = if vertical { (128, 240) } else { (240, 128) };
        RgbaImage::from_fn(width, height, |x, y| {
            let (cross, pos) = if vertical {
                (x, y + offset)
            } else {
                (y, x + offset)
            };
            // Unique pseudo text lines on a bright page, including blank gaps.
            let row = pos / 17;
            let ink = pos % 17 >= 4
                && pos % 17 < 9
                && cross > 8
                && cross < 118
                && ((cross / 5 + row * 7) % 13) < (row % 6 + 3);
            if ink {
                Rgba([20 + (row % 30) as u8, 25, 35, 255])
            } else {
                Rgba([245, 246, 247, 255])
            }
        })
    }

    #[test]
    fn exact_forward_seams_work_in_both_directions_and_all_pixel_offsets() {
        for vertical in [true, false] {
            let first = image(vertical, 0);
            for offset in [19, 61, 101, 149] {
                let next = image(vertical, offset);
                assert_eq!(
                    reliable_overlap(&first, &next, vertical),
                    Some(240 - offset),
                    "vertical={vertical}, offset={offset}"
                );
                assert_eq!(reliable_overlap(&next, &first, vertical), None);
            }
        }
    }

    #[test]
    fn refuses_blank_identical_repeating_unrelated_and_insufficient_overlap() {
        let blank = RgbaImage::from_pixel(128, 240, Rgba([255, 255, 255, 255]));
        assert_eq!(reliable_overlap(&blank, &blank, true), None);
        let first = image(true, 0);
        assert_eq!(reliable_overlap(&first, &first, true), None);
        assert_eq!(reliable_overlap(&first, &image(true, 210), true), None);
        let periodic = |offset| {
            RgbaImage::from_fn(128, 240, |x, y| {
                let color = if ((y + offset) / 6 + x / 9) % 2 == 0 {
                    0
                } else {
                    255
                };
                Rgba([color, color, color, 255])
            })
        };
        assert_eq!(reliable_overlap(&periodic(0), &periodic(60), true), None);
        let noise = RgbaImage::from_fn(128, 240, |x, y| {
            Rgba([
                (x * 11 % 251) as u8,
                (y * 13 % 251) as u8,
                ((x * y) % 251) as u8,
                255,
            ])
        });
        assert_eq!(reliable_overlap(&first, &noise, true), None);
    }

    #[test]
    fn refuses_fixed_textured_headers_sidebars_and_large_dynamic_regions() {
        let mut first = image(true, 0);
        let mut next = image(true, 61);
        for y in 0..30 {
            for x in 0..128 {
                let v = if (x / 5 + y / 3) % 2 == 0 { 20 } else { 230 };
                first.put_pixel(x, y, Rgba([v, v, v, 255]));
                next.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        assert_eq!(reliable_overlap(&first, &next, true), None);
        let mut first = image(true, 0);
        let mut next = image(true, 61);
        for y in 0..240 {
            for x in 0..16 {
                let v = if (x / 2 + y / 7) % 2 == 0 { 20 } else { 230 };
                first.put_pixel(x, y, Rgba([v, v, v, 255]));
                next.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        assert_eq!(reliable_overlap(&first, &next, true), None);
        let first = image(true, 0);
        let mut next = image(true, 61);
        for y in 40..120 {
            for x in 30..100 {
                next.put_pixel(x, y, Rgba([200, 30, 20, 255]));
            }
        }
        assert_eq!(reliable_overlap(&first, &next, true), None);
    }

    #[test]
    fn matches_native_fixture_at_full_resolution() {
        let frame = |offset| {
            RgbaImage::from_fn(380, 250, |x, y| {
                let y = y + offset;
                Rgba([
                    ((x * 13 + y * 17) % 251) as u8,
                    ((x * 3 + y * 23) % 253) as u8,
                    ((x * 31 + y * 7) % 255) as u8,
                    255,
                ])
            })
        };
        assert_eq!(reliable_overlap(&frame(0), &frame(60), true), Some(190));
        assert_eq!(reliable_overlap(&frame(60), &frame(0), true), None);
    }

    #[test]
    fn sparse_text_on_a_wide_white_page_still_has_a_unique_seam() {
        let page = |offset: u32| {
            RgbaImage::from_fn(1200, 900, |x, y| {
                let y = y + offset;
                let line = y / 34;
                let glyph = x.saturating_sub(90) / 8;
                let ink = (90..490).contains(&x)
                    && (7..17).contains(&(y % 34))
                    && (x - 90) % 8 < 3
                    && ((glyph.wrapping_mul(1_103_515_245) ^ line.wrapping_mul(2_654_435_761))
                        .wrapping_mul(2_246_822_519)
                        >> 27)
                        < 14;
                if ink {
                    Rgba([35, 40, 48, 255])
                } else {
                    Rgba([255, 255, 255, 255])
                }
            })
        };
        assert_eq!(reliable_overlap(&page(0), &page(275), true), Some(625));
    }
}
