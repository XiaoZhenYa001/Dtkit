use super::{MAX_IMAGE_BYTES, MAX_PIXELS};
use base64::Engine;
use std::io::Cursor;
use std::time::{Duration, Instant};

pub(super) struct Imported {
    pub(super) source: String,
    pub(super) png: Result<Vec<u8>, String>,
}

// Only read attributes; copied markup is never executed or mounted in a WebView.
pub(super) fn tags(html: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut result = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        let tail = &rest[start + 1..];
        if tail.starts_with("!--") {
            if let Some(end) = tail.find("-->") {
                rest = &tail[end + 3..];
                continue;
            } else {
                break;
            }
        }
        let mut quote = None;
        let mut end = None;
        for (i, c) in tail.char_indices() {
            if let Some(q) = quote {
                if c == q {
                    quote = None;
                }
            } else if c == '\'' || c == '"' {
                quote = Some(c);
            } else if c == '>' {
                end = Some(i);
                break;
            }
        }
        let Some(end) = end else { break };
        let tag = &tail[..end];
        rest = &tail[end + 1..];
        let size = tag
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(tag.len());
        let name = tag[..size].to_ascii_lowercase();
        if matches!(name.as_str(), "script" | "style") {
            let close = format!("</{name}>");
            if let Some(end) = rest.to_ascii_lowercase().find(&close) {
                rest = &rest[end + close.len()..];
            } else {
                break;
            }
            continue;
        }
        if !matches!(name.as_str(), "img" | "a") {
            continue;
        }
        let mut attrs = Vec::new();
        let mut rem = &tag[size..];
        while !rem.trim().is_empty() {
            rem = rem.trim_start();
            let n = rem
                .find(|c: char| c.is_whitespace() || c == '=')
                .unwrap_or(rem.len());
            if n == 0 {
                break;
            }
            let key = rem[..n].to_ascii_lowercase();
            rem = rem[n..].trim_start();
            let Some(value) = rem.strip_prefix('=') else {
                continue;
            };
            rem = value.trim_start();
            let (value, length) = if rem.starts_with(['\'', '"']) {
                let q = rem.chars().next().unwrap();
                let end = rem[1..].find(q).map(|n| n + 1).unwrap_or(rem.len());
                (&rem[1..end], (end + 1).min(rem.len()))
            } else {
                let end = rem.find(char::is_whitespace).unwrap_or(rem.len());
                (&rem[..end], end)
            };
            attrs.push((key, super::clipboard::decode_entities(value)));
            rem = &rem[length..];
        }
        result.push((name, attrs));
        if result.len() >= 1000 {
            break;
        }
    }
    result
}

pub(super) fn prepare(html: &str, has_native_image: bool) -> Vec<Imported> {
    let source = html
        .lines()
        .find_map(|l| l.strip_prefix("SourceURL:"))
        .and_then(|s| tauri::Url::parse(s.trim()).ok());
    let mut urls = Vec::new();
    for (name, attrs) in tags(super::clipboard::html_fragment(html)) {
        if name != "img" {
            continue;
        }
        let Some((_, url)) = attrs.iter().find(|(k, _)| k == "src") else {
            continue;
        };
        let url = if url.starts_with("data:image/") {
            url.clone()
        } else {
            tauri::Url::parse(url)
                .ok()
                .or_else(|| source.as_ref()?.join(url).ok())
                .map(|u| u.to_string())
                .unwrap_or_default()
        };
        if (url.starts_with("http://")
            || url.starts_with("https://")
            || url.starts_with("data:image/"))
            && !urls.contains(&url)
        {
            urls.push(url);
        }
    }
    if has_native_image && urls.len() == 1 {
        return Vec::new();
    }
    let started = Instant::now();
    let mut total = 0;
    urls.into_iter()
        .take(64)
        .enumerate()
        .map(|(index, url)| {
            let png = if index >= 8
                || total >= 24 * 1024 * 1024
                || started.elapsed() > Duration::from_secs(6)
            {
                Err("当前复制的图片过多，请单独复制所需图片".into())
            } else {
                let bytes = if url.starts_with("data:image/") {
                    url.split_once(",")
                        .filter(|(head, _)| head.ends_with(";base64"))
                        .ok_or("图片嵌入格式不支持".to_string())
                        .and_then(|(_, data)| {
                            if data.len() > MAX_IMAGE_BYTES * 4 / 3 + 8 {
                                Err("嵌入图片超过 32 MB".into())
                            } else {
                                base64::engine::general_purpose::STANDARD
                                    .decode(data)
                                    .map_err(|_| "嵌入图片无法解码".into())
                            }
                        })
                } else {
                    download(&url, started)
                };
                bytes.and_then(|b| {
                    let png = canonical_png(&b)?;
                    if total + png.len() > MAX_IMAGE_BYTES {
                        return Err("本次图片总量较大，请分批复制".into());
                    }
                    total += png.len();
                    Ok(png)
                })
            };
            Imported { source: url, png }
        })
        .collect()
}

fn canonical_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("单张图片超过 32 MB".into());
    }
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "图片格式无法识别")?;
    let (w, h) = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "图片格式无法识别")?
        .into_dimensions()
        .map_err(|_| "图片尺寸无法读取")?;
    if w > 16384 || h > 16384 || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("图片尺寸超过 4000 万像素".into());
    }
    let mut reader = reader;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4 + 16 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "图片无法解码")?;
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

#[cfg(windows)]
fn download(url: &str, started: Instant) -> Result<Vec<u8>, String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Networking::WinHttp::*;
    struct Internet(*mut core::ffi::c_void);
    impl Drop for Internet {
        fn drop(&mut self) {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
    let handle = |p: *mut core::ffi::c_void| {
        if p.is_null() {
            Err("图片来源连接失败".to_string())
        } else {
            Ok(Internet(p))
        }
    };
    let url = tauri::Url::parse(url).map_err(|_| "图片地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("图片地址不支持".into());
    }
    let host = url
        .host_str()
        .ok_or("图片缺少来源地址")?
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    let path = path.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        let session = handle(WinHttpOpen(
            w!("DtKit ClipboardPuzzle"),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?;
        WinHttpSetTimeouts(session.0, 1500, 1500, 1500, 1500).map_err(|e| e.to_string())?;
        let connect = handle(WinHttpConnect(
            session.0,
            PCWSTR(host.as_ptr()),
            url.port_or_known_default().ok_or("图片端口无效")?,
            0,
        ))?;
        let flags = if url.scheme() == "https" {
            WINHTTP_FLAG_SECURE
        } else {
            WINHTTP_OPEN_REQUEST_FLAGS(0)
        };
        let request = handle(WinHttpOpenRequest(
            connect.0,
            w!("GET"),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            core::ptr::null(),
            flags,
        ))?;
        WinHttpSendRequest(request.0, None, None, 0, 0, 0).map_err(|_| "图片来源请求失败")?;
        WinHttpReceiveResponse(request.0, core::ptr::null_mut()).map_err(|_| "图片来源响应超时")?;
        let mut status = 0u32;
        let mut size = 4;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some((&mut status as *mut u32).cast()),
            &mut size,
            core::ptr::null_mut(),
        )
        .map_err(|e| e.to_string())?;
        if !(200..300).contains(&status) {
            return Err(format!("图片来源返回 {status}"));
        }
        let mut output = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            if started.elapsed() > Duration::from_secs(6) {
                return Err("图片来源读取超时".into());
            }
            let mut read = 0;
            WinHttpReadData(
                request.0,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut read,
            )
            .map_err(|_| "图片来源读取失败")?;
            if read == 0 {
                break;
            }
            if output.len() + read as usize > 8 * 1024 * 1024 {
                return Err("远程图片超过 8 MB，请单独复制图片".into());
            }
            output.extend_from_slice(&chunk[..read as usize]);
        }
        Ok(output)
    }
}
#[cfg(not(windows))]
fn download(_url: &str, _started: Instant) -> Result<Vec<u8>, String> {
    Err("图片来源下载仅支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attribute_reader_respects_quotes_and_does_not_confuse_data_attributes() {
        let tags=tags("<a data-href='wrong' HREF=\"https://example.com/?v=>\">x</a><img src='data:image/png;base64,abcd' alt='pic'>");
        assert_eq!(
            tags[0].1[1],
            ("href".into(), "https://example.com/?v=>".into())
        );
        assert_eq!(tags[1].0, "img");
    }
    #[test]
    fn embedded_images_are_decoded_without_fetching() {
        let mut data = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(3, 2)
            .write_to(&mut data, image::ImageFormat::Png)
            .unwrap();
        let html = format!(
            "<img src='data:image/png;base64,{}'>",
            base64::engine::general_purpose::STANDARD.encode(data.get_ref())
        );
        let imported = prepare(&html, false);
        assert_eq!(imported.len(), 1);
        assert!(imported[0].png.is_ok());
    }
}
