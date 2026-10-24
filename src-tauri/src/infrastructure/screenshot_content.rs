use base64::Engine;
use serde::Serialize;
use std::io::Cursor;

pub(super) const MAX_SCREENSHOT_BYTES: usize = 100 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000;

pub(super) fn png_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("截图数据必须是 PNG 图片")?;
    if encoded.len() > MAX_SCREENSHOT_BYTES.saturating_mul(4) / 3 + 8 {
        return Err("截图数据超过 100 MB 限制".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "截图数据损坏")?;
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err("截图数据超过 100 MB 限制".into());
    }
    Ok(bytes)
}

pub(super) fn decode_png(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    let dimensions = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png)
        .into_dimensions()
        .map_err(|_| "PNG 图片无法读取")?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || dimensions.0 > 16_384
        || dimensions.1 > 16_384
        || u64::from(dimensions.0) * u64::from(dimensions.1) > MAX_PIXELS
    {
        return Err("截图尺寸过大，最多支持 4000 万像素和单边 16384 像素".into());
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(MAX_PIXELS * 4 + 16 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map(|image| image.to_rgba8())
        .map_err(|_| "PNG 图片像素不完整或无法解码".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenshotText {
    text: String,
    language: String,
}

#[cfg(windows)]
fn recognize(image: image::RgbaImage) -> Result<ScreenshotText, String> {
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    // A blocking worker owns its WinRT apartment until the async OCR operation
    // has completed. No COM object crosses the WebView/UI thread boundary.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        .map_err(|error| format!("无法启动本地文字识别：{error}"))?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    let _apartment = Apartment;
    let error = |error| format!("本地文字识别失败：{error}");
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().or_else(|_| {
        let languages = OcrEngine::AvailableRecognizerLanguages()?;
        OcrEngine::TryCreateFromLanguage(&languages.GetAt(0)?)
    }).map_err(|_| "没有可用的 Windows 文字识别语言。请在系统‘语言和区域’中安装中文或英文的基本输入/文字识别语言功能后重试".to_string())?;
    let max_dimension = OcrEngine::MaxImageDimension().map_err(error)?;
    let mut image = if image.width() > max_dimension || image.height() > max_dimension {
        image::imageops::thumbnail(&image, max_dimension, max_dimension)
    } else {
        image
    };
    // Composite transparent export corners onto white and send opaque BGRA8.
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        let flatten =
            |value: u8| ((u32::from(value) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        *pixel = image::Rgba([flatten(pixel[2]), flatten(pixel[1]), flatten(pixel[0]), 255]);
    }
    let writer = DataWriter::new().map_err(error)?;
    writer.WriteBytes(image.as_raw()).map_err(error)?;
    let buffer = writer.DetachBuffer().map_err(error)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        image.width() as i32,
        image.height() as i32,
        BitmapAlphaMode::Ignore,
    )
    .map_err(error)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(error)?
        .get()
        .map_err(error)?;
    let lines = result.Lines().map_err(error)?;
    let mut text = Vec::new();
    for index in 0..lines.Size().map_err(error)? {
        text.push(
            lines
                .GetAt(index)
                .map_err(error)?
                .Text()
                .map_err(error)?
                .to_string(),
        );
    }
    Ok(ScreenshotText {
        text: text.join("\n"),
        language: engine
            .RecognizerLanguage()
            .map_err(error)?
            .LanguageTag()
            .map_err(error)?
            .to_string(),
    })
}

#[tauri::command]
pub(crate) async fn recognize_screenshot_text(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<ScreenshotText, String> {
    let _work = super::launch::keep_native_work(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = png_bytes(&data_url)?;
        let image = decode_png(&bytes)?;
        #[cfg(windows)]
        {
            recognize(image)
        }
        #[cfg(not(windows))]
        {
            let _ = image;
            Err("本地文字识别当前仅支持 Windows".into())
        }
    })
    .await
    .map_err(|error| format!("文字识别任务异常结束：{error}"))?
}

#[tauri::command]
pub(crate) async fn copy_screenshot_to_clipboard(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<(), String> {
    let _work = super::launch::keep_native_work(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = png_bytes(&data_url)?;
        decode_png(&bytes)?;
        // Publishes native PNG and CF_DIBV5, preserving transparency for apps
        // that support it and enabling paste in older Windows applications.
        super::clipboard_puzzle::write_png_to_clipboard(&bytes)
    })
    .await
    .map_err(|error| format!("复制图片任务异常结束：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_actual_png_content_before_clipboard_save_or_ocr() {
        assert!(png_bytes("data:text/plain;base64,AA==").is_err());
        assert!(png_bytes("data:image/png;base64,@@").is_err());
        assert!(decode_png(&png_bytes("data:image/png;base64,AA==").unwrap()).is_err());
        let image = image::RgbaImage::from_pixel(2, 3, image::Rgba([10, 20, 30, 255]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        assert_eq!(decode_png(bytes.get_ref()).unwrap().dimensions(), (2, 3));
        let truncated = &bytes.get_ref()[..40];
        assert!(decode_png(truncated).is_err());
    }
}
