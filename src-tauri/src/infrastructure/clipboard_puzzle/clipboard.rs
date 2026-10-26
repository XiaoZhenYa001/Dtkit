use super::repository::{Node, Repository};
use super::{MAX_IMAGE_BYTES, MAX_PIXELS};
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const MAX_TEXT: usize = 1024 * 1024;
const MAX_HTML: usize = 4 * 1024 * 1024;
static OUTPUT_TOKEN: OnceLock<Vec<u8>> = OnceLock::new();
fn token() -> &'static [u8] {
    OUTPUT_TOKEN.get_or_init(|| uuid::Uuid::new_v4().as_bytes().to_vec())
}

pub(crate) struct Capture {
    pub(crate) sequence: u32,
    text: String,
    html: String,
    image: Option<Image>,
    pub(crate) ignored: bool,
}
enum Image {
    Png(Vec<u8>),
    Dib(Vec<u8>),
}
impl Capture {
    pub(super) fn from_content(text: String, html: String) -> Result<Self, String> {
        if text.len() > MAX_TEXT || html.len() > MAX_HTML {
            return Err("拖入的内容过大，请分批插入".into());
        }
        Ok(Self {
            sequence: 0,
            text,
            html,
            image: None,
            ignored: false,
        })
    }
    pub(super) fn prepare_images(&self) -> Vec<super::images::Imported> {
        if self.ignored {
            Vec::new()
        } else {
            super::images::prepare(&self.html, self.image.is_some())
        }
    }
    pub(super) fn nodes(
        self,
        repo: &mut Repository,
        images: Vec<super::images::Imported>,
    ) -> Result<Vec<Node>, String> {
        if self.ignored {
            return Err("该剪贴板内容已设置为不收集".into());
        }
        let group = uuid::Uuid::new_v4().to_string();
        let mut nodes = Vec::new();
        let mut y = 0.;
        if let Some(image) = self.image {
            let png = match image {
                Image::Png(bytes) => bytes,
                Image::Dib(bytes) => dib_to_png(&bytes)?,
            };
            let asset = repo.store_png(&png)?;
            let mut n = Node::new("image");
            n.name = "收集的图片".into();
            n.asset_id = Some(asset.asset_id);
            n.w = 320.;
            n.h = (320. * f64::from(asset.height) / f64::from(asset.width)).max(16.);
            n.x = 0.;
            n.y = y;
            y += n.h + 18.;
            nodes.push(n);
        }
        for imported in images {
            match imported.png {
                Ok(png) => {
                    let asset = repo.store_png(&png)?;
                    if nodes
                        .iter()
                        .any(|n| n.asset_id.as_deref() == Some(&asset.asset_id))
                    {
                        continue;
                    }
                    let mut n = Node::new("image");
                    n.name = "原文中的图片".into();
                    n.asset_id = Some(asset.asset_id);
                    n.w = 320.;
                    n.h = (320. * f64::from(asset.height) / f64::from(asset.width)).max(16.);
                    n.x = 0.;
                    n.y = y;
                    y += n.h + 18.;
                    nodes.push(n);
                }
                Err(error) => {
                    let mut n = Node::new(if is_link(&imported.source) {
                        "link"
                    } else {
                        "text"
                    });
                    n.name = "图片未取得 · 可打开来源".into();
                    if n.kind == "link" {
                        n.url = imported.source;
                    }
                    n.body = format!("图片原件未取得：{error}。可单独复制图片后粘贴。");
                    n.original_body = n.body.clone();
                    n.x = 0.;
                    n.y = y;
                    n.h = 120.;
                    y += 138.;
                    nodes.push(n);
                }
            }
        }
        let text = if self.text.is_empty() {
            plain_html(&self.html)
        } else {
            self.text
        };
        if !text.trim().is_empty() {
            let url = is_link(text.trim());
            let mut n = Node::new(if url { "link" } else { "text" });
            n.name = if url {
                "收集的链接"
            } else {
                "收集的文字"
            }
            .into();
            n.body = text.clone();
            n.original_body = text.clone();
            if url {
                n.url = text.trim().into();
                n.h = 120.;
            } else {
                n.h = estimate_height(&text);
            };
            n.x = 0.;
            n.y = y;
            y += n.h + 18.;
            nodes.push(n);
        }
        for url in html_links(&self.html) {
            if nodes.iter().any(|n| n.url == url) {
                continue;
            }
            let mut n = Node::new("link");
            n.name = "原文中的链接".into();
            n.url = url;
            n.x = 0.;
            n.y = y;
            n.h = 120.;
            y += 138.;
            nodes.push(n);
        }
        if nodes.is_empty() {
            return Err("当前剪贴板没有可收集的文字、链接或图片".into());
        }
        let source = self
            .html
            .lines()
            .find_map(|line| line.strip_prefix("SourceURL:"))
            .filter(|u| is_link(u.trim()))
            .map(|u| u.trim().to_string());
        for n in &mut nodes {
            n.group_id = Some(group.clone());
            n.source_url = source.clone();
        }
        Ok(nodes)
    }
}
fn estimate_height(text: &str) -> f64 {
    let lines = text
        .split('\n')
        .map(|l| l.chars().count().div_ceil(12))
        .map(|n| n.max(1))
        .sum::<usize>();
    (66. + lines as f64 * 30.).max(100.)
}
fn is_link(value: &str) -> bool {
    (value.starts_with("https://") || value.starts_with("http://"))
        && !value.chars().any(char::is_whitespace)
        && value.len() <= 8192
}

// A bounded lexical reader extracts only text and href values; no HTML is executed
// Native CF_UNICODETEXT is preferred whenever the source supplies it.
fn plain_html(html: &str) -> String {
    let fragment = html_fragment(html);
    let mut result = String::new();
    let mut chars = fragment.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            let mut tag = String::new();
            let mut quote = None;
            for ch in chars.by_ref() {
                if let Some(q) = quote {
                    if ch == q {
                        quote = None;
                    }
                } else if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                } else if ch == '>' {
                    break;
                }
                tag.push(ch);
            }
            let lower = tag.trim().to_ascii_lowercase();
            if lower.starts_with("script") || lower.starts_with("style") {
                let end = if lower.starts_with("script") {
                    "</script>"
                } else {
                    "</style>"
                };
                let rest = chars.by_ref().collect::<String>();
                let tail = rest
                    .to_ascii_lowercase()
                    .find(end)
                    .map(|p| &rest[p + end.len()..])
                    .unwrap_or("");
                result.push_str(&plain_html(tail));
                break;
            }
            if lower.starts_with("br")
                || lower.starts_with("/p")
                || lower.starts_with("/div")
                || lower.starts_with("/li")
            {
                result.push('\n');
            }
        } else {
            result.push(c);
        }
    }
    decode_entities(&result).trim_matches('\n').to_string()
}
pub(super) fn decode_entities(s: &str) -> String {
    let mut result = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('&') {
        result.push_str(&rest[..start]);
        let tail = &rest[start..];
        if let Some(end) = tail.find(';').filter(|e| *e <= 12) {
            let code = &tail[1..end];
            let value = match code {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ => code
                    .strip_prefix("#x")
                    .or_else(|| code.strip_prefix("#X"))
                    .and_then(|v| u32::from_str_radix(v, 16).ok())
                    .or_else(|| code.strip_prefix('#').and_then(|v| v.parse().ok()))
                    .and_then(char::from_u32),
            };
            if let Some(c) = value {
                result.push(c);
                rest = &tail[end + 1..];
                continue;
            }
        }
        result.push('&');
        rest = &tail[1..];
    }
    result.push_str(rest);
    result
}
pub(super) fn html_fragment(html: &str) -> &str {
    let number = |key: &str| {
        html.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|s| s.trim().parse::<usize>().ok())
    };
    if let (Some(start), Some(end)) = (number("StartFragment:"), number("EndFragment:")) {
        if start <= end
            && end <= html.len()
            && html.is_char_boundary(start)
            && html.is_char_boundary(end)
        {
            return &html[start..end];
        }
    }
    html
}
fn html_links(html: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for (name, attrs) in super::images::tags(html_fragment(html)) {
        if name != "a" {
            continue;
        }
        if let Some((_, url)) = attrs.into_iter().find(|(key, _)| key == "href") {
            if is_link(&url) && !urls.contains(&url) && urls.len() < 64 {
                urls.push(url);
            }
        }
    }
    urls
}

fn u16_at(b: &[u8], p: usize) -> Result<u16, String> {
    b.get(p..p + 2)
        .map(|s| u16::from_le_bytes(s.try_into().unwrap()))
        .ok_or("位图头不完整".into())
}
fn u32_at(b: &[u8], p: usize) -> Result<u32, String> {
    b.get(p..p + 4)
        .map(|s| u32::from_le_bytes(s.try_into().unwrap()))
        .ok_or("位图头不完整".into())
}
fn dib_to_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let header = u32_at(bytes, 0)? as usize;
    if !(40..=124).contains(&header) || header > bytes.len() {
        return Err("暂不支持这种剪贴板位图头".into());
    }
    let w = u32_at(bytes, 4)? as i32;
    let signed_h = u32_at(bytes, 8)? as i32;
    let h = signed_h.unsigned_abs();
    let bits = u16_at(bytes, 14)?;
    let compression = u32_at(bytes, 16)?;
    if w <= 0
        || h == 0
        || h > 16_384
        || w > 16_384
        || u64::from(w as u32) * u64::from(h) > MAX_PIXELS
        || u16_at(bytes, 12)? != 1
        || !matches!(bits, 24 | 32)
        || !matches!(compression, 0 | 3 | 6)
    {
        return Err("剪贴板位图格式或尺寸不支持".into());
    }
    let masks = if header == 40 && compression == 3 {
        12
    } else if header == 40 && compression == 6 {
        16
    } else {
        0
    };
    let palette = u32_at(bytes, 32)? as usize;
    let offset = header
        .checked_add(masks)
        .and_then(|n| n.checked_add(palette.checked_mul(4)?))
        .ok_or("位图容量无效")?;
    if compression != 0 {
        let base = 40;
        if u32_at(bytes, base)? != 0x00ff0000
            || u32_at(bytes, base + 4)? != 0x0000ff00
            || u32_at(bytes, base + 8)? != 0x000000ff
        {
            return Err("暂不支持这种位图颜色掩码".into());
        }
    }
    let stride = (w as usize * bits as usize).div_ceil(32) * 4;
    let size = stride.checked_mul(h as usize).ok_or("位图容量无效")?;
    let pixels = bytes
        .get(offset..offset.checked_add(size).ok_or("位图容量无效")?)
        .ok_or("位图像素不完整")?;
    let has_alpha = bits == 32
        && ((header >= 56 && u32_at(bytes, 52)? != 0)
            || compression == 6
            || compression == 0 && pixels.chunks_exact(4).any(|p| p[3] != 0));
    let mut rgba = vec![0; w as usize * h as usize * 4];
    for y in 0..h as usize {
        let row = if signed_h < 0 { y } else { h as usize - 1 - y };
        for x in 0..w as usize {
            let source = row * stride + x * (bits as usize / 8);
            let dest = (y * w as usize + x) * 4;
            rgba[dest..dest + 4].copy_from_slice(&[
                pixels[source + 2],
                pixels[source + 1],
                pixels[source],
                if has_alpha { pixels[source + 3] } else { 255 },
            ]);
        }
    }
    let image = image::RgbaImage::from_raw(w as u32, h, rgba).ok_or("位图无法转换")?;
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(output.into_inner())
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use std::sync::mpsc::{self, SyncSender};
    use std::time::Duration;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    fn open(owner: HWND) -> Result<Guard, String> {
        for _ in 0..8 {
            if unsafe { OpenClipboard(owner) }.is_ok() {
                return Ok(Guard);
            }
            std::thread::sleep(Duration::from_millis(12));
        }
        Err("剪贴板正在被其他程序使用，请稍后重试".into())
    }
    fn format(name: &str) -> u32 {
        let wide = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) }
    }
    fn bytes(format: u32, limit: usize) -> Result<Option<Vec<u8>>, String> {
        if unsafe { IsClipboardFormatAvailable(format) }.is_err() {
            return Ok(None);
        }
        let handle = unsafe { GetClipboardData(format) }.map_err(|_| "读取剪贴板格式失败")?;
        let memory = HGLOBAL(handle.0);
        let len = unsafe { GlobalSize(memory) };
        if len > limit {
            return Err("剪贴板内容超过安全容量，请分段收集".into());
        }
        let ptr = unsafe { GlobalLock(memory) } as *const u8;
        if ptr.is_null() {
            return Err("剪贴板数据无法锁定".into());
        }
        let result = unsafe { std::slice::from_raw_parts(ptr, len).to_vec() };
        unsafe {
            let _ = GlobalUnlock(memory);
        }
        Ok(Some(result))
    }
    pub(super) fn read(ignore_own: bool) -> Result<Capture, String> {
        for _ in 0..3 {
            let sequence = unsafe { GetClipboardSequenceNumber() };
            let _guard = open(HWND::default())?;
            let excluded = unsafe {
                IsClipboardFormatAvailable(format("ExcludeClipboardContentFromMonitorProcessing"))
            }
            .is_ok();
            let history = bytes(format("CanIncludeInClipboardHistory"), 64)?
                .is_some_and(|b| b.get(..4) == Some(&0_u32.to_le_bytes()));
            let own =
                bytes(format("DtKit.ClipboardPuzzle.Output.v1"), 64)?.is_some_and(|b| b == token());
            if excluded || history || (ignore_own && own) {
                return Ok(Capture {
                    sequence,
                    text: String::new(),
                    html: String::new(),
                    image: None,
                    ignored: true,
                });
            }
            let text = if let Some(bytes) = bytes(13, MAX_TEXT * 2 + 2)? {
                let words = bytes
                    .chunks_exact(2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .take_while(|c| *c != 0)
                    .collect::<Vec<_>>();
                String::from_utf16(&words).map_err(|_| "剪贴板文字编码无效")?
            } else {
                String::new()
            };
            let html = if let Some(bytes) = bytes(format("HTML Format"), MAX_HTML)? {
                String::from_utf8(bytes.into_iter().take_while(|b| *b != 0).collect())
                    .map_err(|_| "剪贴板 HTML 编码无效")?
            } else {
                String::new()
            };
            let image = if let Some(bytes) = bytes(format("PNG"), MAX_IMAGE_BYTES)? {
                Some(Image::Png(bytes))
            } else if let Some(bytes) = bytes(17, MAX_PIXELS as usize * 4 + 1024)? {
                Some(Image::Dib(bytes))
            } else {
                bytes(8, MAX_PIXELS as usize * 4 + 1024)?.map(Image::Dib)
            };
            let ignored = text.trim().is_empty()
                && plain_html(&html).is_empty()
                && html_links(&html).is_empty()
                && !super::super::images::tags(html_fragment(&html))
                    .iter()
                    .any(|(name, _)| name == "img")
                && image.is_none();
            if unsafe { GetClipboardSequenceNumber() } == sequence {
                return Ok(Capture {
                    sequence,
                    text,
                    html,
                    image,
                    ignored,
                });
            }
        }
        Err("剪贴板正在快速变化，这次内容未能完整取得".into())
    }

    struct Buffer(HGLOBAL, bool);
    impl Drop for Buffer {
        fn drop(&mut self) {
            if !self.1 {
                unsafe {
                    let _ = windows::Win32::Foundation::GlobalFree(self.0);
                }
            }
        }
    }
    fn buffer(bytes: &[u8]) -> Result<Buffer, String> {
        let memory =
            unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }.map_err(|_| "剪贴板内存分配失败")?;
        let mut result = Buffer(memory, false);
        let ptr = unsafe { GlobalLock(memory) };
        if ptr.is_null() {
            return Err("剪贴板内存无法锁定".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.cast(), bytes.len());
            let _ = GlobalUnlock(memory);
        }
        result.1 = false;
        Ok(result)
    }
    fn put(format: u32, mut memory: Buffer) -> Result<(), String> {
        unsafe { SetClipboardData(format, HANDLE(memory.0 .0)) }
            .map_err(|e| format!("写入剪贴板失败：{e}"))?;
        memory.1 = true;
        Ok(())
    }
    unsafe extern "system" fn output_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
    fn owner_window() -> Result<HWND, String> {
        unsafe {
            let class = WNDCLASSW {
                lpfnWndProc: Some(output_proc),
                lpszClassName: w!("DtKit.PuzzleOutput"),
                ..Default::default()
            };
            RegisterClassW(&class);
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("DtKit.PuzzleOutput"),
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                None,
                None,
            )
            .map_err(|e| e.to_string())
        }
    }
    struct WindowGuard(HWND);
    impl Drop for WindowGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }
    fn write(formats: Vec<(u32, Vec<u8>)>) -> Result<(), String> {
        let mut prepared = Vec::new();
        prepared.push((format("DtKit.ClipboardPuzzle.Output.v1"), buffer(token())?));
        for (id, bytes) in formats {
            prepared.push((id, buffer(&bytes)?));
        }
        let window = WindowGuard(owner_window()?);
        let _guard = open(window.0)?;
        unsafe { EmptyClipboard() }.map_err(|e| e.to_string())?;
        for (id, memory) in prepared {
            put(id, memory)?;
        }
        Ok(())
    }
    pub(super) fn write_text(value: &str) -> Result<(), String> {
        if value.len() > MAX_TEXT {
            return Err("文字超过剪贴板容量".into());
        }
        let words = value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let bytes = words.iter().flat_map(|w| w.to_le_bytes()).collect();
        write(vec![(13, bytes)])
    }
    pub(super) fn write_png(bytes: &[u8]) -> Result<(), String> {
        let image = super::super::repository::validate_png(bytes)?.to_rgba8();
        let (w, h) = image.dimensions();
        let mut dib = vec![0; 124 + w as usize * h as usize * 4];
        dib[0..4].copy_from_slice(&124_u32.to_le_bytes());
        dib[4..8].copy_from_slice(&w.to_le_bytes());
        dib[8..12].copy_from_slice(&(-(h as i32)).to_le_bytes());
        dib[12..14].copy_from_slice(&1_u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32_u16.to_le_bytes());
        dib[16..20].copy_from_slice(&3_u32.to_le_bytes());
        for (p, v) in [
            (40, 0x00ff0000_u32),
            (44, 0x0000ff00),
            (48, 0x000000ff),
            (52, 0xff000000),
            (56, 0x73524742),
        ] {
            dib[p..p + 4].copy_from_slice(&v.to_le_bytes());
        }
        for (pixel, out) in image.pixels().zip(dib[124..].chunks_exact_mut(4)) {
            out.copy_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
        write(vec![(format("PNG"), bytes.to_vec()), (17, dib)])
    }

    struct Context {
        app: AppHandle,
        sender: SyncSender<Job>,
        last: AtomicU32,
        budget: Arc<AtomicUsize>,
    }
    struct Budget {
        counter: Arc<AtomicUsize>,
        size: usize,
    }
    impl Drop for Budget {
        fn drop(&mut self) {
            self.counter.fetch_sub(self.size, Ordering::AcqRel);
        }
    }
    struct Job {
        capture: Capture,
        target: String,
        _work: crate::infrastructure::launch::NativeWorkGuard,
        _budget: Budget,
    }
    unsafe extern "system" fn proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        if message == WM_CLIPBOARDUPDATE {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Context;
            if !ptr.is_null() {
                let ctx = &*ptr;
                let sequence = GetClipboardSequenceNumber();
                if sequence != ctx.last.load(Ordering::Relaxed) {
                    let target = ctx
                        .app
                        .state::<super::super::PuzzleManager>()
                        .collection
                        .lock()
                        .ok()
                        .and_then(|s| s.task_id.clone());
                    if let Some(target) = target {
                        match read(true) {
                            Ok(capture) => {
                                ctx.last.store(capture.sequence, Ordering::Relaxed);
                                if !capture.ignored {
                                    let size = capture.text.len()
                                        + capture.html.len()
                                        + match &capture.image {
                                            Some(Image::Png(b) | Image::Dib(b)) => b.len(),
                                            None => 0,
                                        };
                                    let previous = ctx.budget.fetch_add(size, Ordering::AcqRel);
                                    let budget = Budget {
                                        counter: ctx.budget.clone(),
                                        size,
                                    };
                                    if previous.saturating_add(size) > 64 * 1024 * 1024 {
                                        drop(budget);
                                        failure(
                                            &ctx.app,
                                            "收集处理达到内存限额，已暂停；可手动粘贴当前内容"
                                                .into(),
                                        );
                                        let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
                                    } else {
                                        let work = crate::infrastructure::launch::keep_native_work(
                                            &ctx.app,
                                        );
                                        if ctx
                                            .sender
                                            .try_send(Job {
                                                capture,
                                                target,
                                                _work: work,
                                                _budget: budget,
                                            })
                                            .is_err()
                                        {
                                            failure(
                                                &ctx.app,
                                                "收集处理队列已满，已暂停；请整理后重新开启".into(),
                                            );
                                            let _ =
                                                PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
                                        }
                                    }
                                }
                            }
                            Err(error) => {
                                failure(&ctx.app, error);
                                let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
                            }
                        }
                    }
                }
            }
            return LRESULT(0);
        }
        if message == WM_CLOSE {
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
            return LRESULT(0);
        }
        if message == WM_DESTROY {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
    fn failure(app: &AppHandle, error: String) {
        if let Ok(mut state) = app.state::<super::super::PuzzleManager>().collection.lock() {
            state.task_id = None;
            state.error = Some(error);
        }
        let _ = app.emit(super::super::EVENT, serde_json::json!({"taskId":null}));
    }
    pub(super) fn start(
        app: AppHandle,
        hwnd_slot: Arc<AtomicUsize>,
    ) -> Result<std::thread::JoinHandle<()>, String> {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("puzzle-clipboard-listener".into())
            .spawn(move || {
                let (sender, receiver) = mpsc::sync_channel::<Job>(16);
                let worker_app = app.clone();
                let worker = std::thread::Builder::new()
                    .name("puzzle-capture-worker".into())
                    .spawn(move || {
                        while let Ok(job) = receiver.recv() {
                            super::super::capture_changed(&worker_app, job.capture, &job.target);
                        }
                    });
                if worker.is_err() {
                    let _ = ready_tx.send(Err("无法启动图片处理线程".into()));
                    return;
                }
                let context = Box::new(Context {
                    app: app.clone(),
                    sender,
                    last: AtomicU32::new(unsafe { GetClipboardSequenceNumber() }),
                    budget: Arc::new(AtomicUsize::new(0)),
                });
                let result = unsafe {
                    let class = WNDCLASSW {
                        lpfnWndProc: Some(proc),
                        lpszClassName: w!("DtKit.PuzzleListener"),
                        ..Default::default()
                    };
                    RegisterClassW(&class);
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("DtKit.PuzzleListener"),
                        w!(""),
                        WINDOW_STYLE::default(),
                        0,
                        0,
                        0,
                        0,
                        HWND_MESSAGE,
                        None,
                        None,
                        Some((&*context as *const Context).cast()),
                    )
                };
                match result {
                    Ok(hwnd) => {
                        if let Err(error) = unsafe { AddClipboardFormatListener(hwnd) } {
                            let _ = ready_tx.send(Err(error.to_string()));
                            unsafe {
                                let _ = DestroyWindow(hwnd);
                            }
                        } else {
                            hwnd_slot.store(hwnd.0 as usize, Ordering::Release);
                            if ready_tx.send(Ok(())).is_err() {
                                unsafe {
                                    let _ = RemoveClipboardFormatListener(hwnd);
                                    let _ = DestroyWindow(hwnd);
                                }
                            } else {
                                let mut message = MSG::default();
                                while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
                                    unsafe {
                                        let _ = TranslateMessage(&message);
                                        DispatchMessageW(&message);
                                    }
                                }
                            }
                            hwnd_slot.store(0, Ordering::Release);
                        }
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                    }
                }
                drop(context);
                if let Ok(worker) = worker {
                    let _ = worker.join();
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => Ok(thread),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => Err("启动剪贴板监听超时".into()),
        }
    }
    pub(super) fn stop(hwnd: usize) {
        if hwnd != 0 {
            unsafe {
                let _ = PostMessageW(HWND(hwnd as *mut _), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

pub(crate) struct Listener {
    hwnd: Arc<AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Listener {
    pub(crate) fn start(app: AppHandle, hwnd: Arc<AtomicUsize>) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let thread = win::start(app, hwnd.clone())?;
            Ok(Self {
                hwnd,
                thread: Some(thread),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            Err("连续收集目前仅支持 Windows".into())
        }
    }
    pub(crate) fn stop(mut self) {
        #[cfg(windows)]
        win::stop(self.hwnd.load(Ordering::Acquire));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
pub(crate) fn read(ignore_own: bool) -> Result<Capture, String> {
    #[cfg(windows)]
    {
        win::read(ignore_own)
    }
    #[cfg(not(windows))]
    {
        Err("剪贴板收集目前仅支持 Windows".into())
    }
}
pub(crate) fn request_stop(hwnd: &AtomicUsize) {
    #[cfg(windows)]
    win::stop(hwnd.load(Ordering::Acquire));
}
pub(crate) fn write_png(bytes: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::write_png(bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err("剪贴板输出目前仅支持 Windows".into())
    }
}
pub(crate) fn write_text(value: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::write_text(value)
    }
    #[cfg(not(windows))]
    {
        let _ = value;
        Err("剪贴板输出目前仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn html_offsets_are_bytes_and_must_be_valid() {
        let html = "StartFragment:0000000063\r\nEndFragment:0000000078\r\nxxxxxxxxxxx<p>中文</p>";
        assert!(!html_fragment(html).is_empty());
        assert_eq!(
            plain_html("<p>甲 &amp; 乙</p><script>alert(1)</script><p>丙</p>"),
            "甲 & 乙\n丙"
        );
    }
    #[test]
    fn links_never_include_executable_or_duplicate_urls() {
        assert_eq!(html_links("<a href='javascript:alert(1)'>x</a><a href=\"https://example.com/?a=1&amp;b=2\">y</a><a href='https://example.com/?a=1&amp;b=2'>z</a>"),vec!["https://example.com/?a=1&b=2"]);
    }
    #[test]
    fn dib_preserves_top_down_pixels_and_handles_opaque_bgra() {
        let mut b = vec![0; 44];
        b[0..4].copy_from_slice(&40_u32.to_le_bytes());
        b[4..8].copy_from_slice(&1_u32.to_le_bytes());
        b[8..12].copy_from_slice(&(-1_i32).to_le_bytes());
        b[12..14].copy_from_slice(&1_u16.to_le_bytes());
        b[14..16].copy_from_slice(&32_u16.to_le_bytes());
        b[40..44].copy_from_slice(&[10, 20, 30, 0]);
        let png = dib_to_png(&b).unwrap();
        let image = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(image.get_pixel(0, 0).0, [30, 20, 10, 255]);
        assert!(dib_to_png(&b[..42]).is_err());
    }
}
