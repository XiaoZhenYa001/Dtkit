//! A desktop backdrop visual whose sampled pixels share the WebView's outline.
//! The Accent blur policy paints a separate rectangle even outside SetWindowRgn.
use std::{cell::RefCell, collections::HashMap, mem::size_of};
use windows::{
    core::{Interface, Result},
    Foundation::Numerics::Vector2,
    System::{DispatcherQueue, DispatcherQueueController},
    Win32::{
        Foundation::HWND,
        System::WinRT::{
            Composition::ICompositorDesktopInterop, CreateDispatcherQueueController,
            DispatcherQueueOptions, DQTAT_COM_STA, DQTYPE_THREAD_CURRENT,
        },
    },
    UI::Composition::{
        CompositionRoundedRectangleGeometry, Compositor, Desktop::DesktopWindowTarget, SpriteVisual,
    },
};

thread_local! {
    // All calls are on the owning HWND's UI thread. Reuse the queue/compositor
    // across show, focus, resize and DPI changes; retain only one target per HWND.
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

struct Host {
    surfaces: HashMap<isize, Surface>,
    compositor: Compositor,
    _queue: Option<DispatcherQueueController>,
}

struct Surface {
    target: DesktopWindowTarget,
    visual: SpriteVisual,
    geometry: CompositionRoundedRectangleGeometry,
}

impl Drop for Surface {
    fn drop(&mut self) {
        let _ = self.target.Close();
    }
}

impl Host {
    fn new() -> Result<Self> {
        let queue = if DispatcherQueue::GetForCurrentThread().is_ok() {
            None
        } else {
            Some(unsafe {
                CreateDispatcherQueueController(DispatcherQueueOptions {
                    dwSize: size_of::<DispatcherQueueOptions>() as u32,
                    threadType: DQTYPE_THREAD_CURRENT,
                    apartmentType: DQTAT_COM_STA,
                })?
            })
        };
        Ok(Self {
            surfaces: HashMap::new(),
            compositor: Compositor::new()?,
            _queue: queue,
        })
    }

    fn configure(&mut self, hwnd: HWND, width: u32, height: u32, radius: f32) -> Result<()> {
        let key = hwnd.0 as isize;
        if !self.surfaces.contains_key(&key) {
            let visual = self.compositor.CreateSpriteVisual()?;
            let geometry = self.compositor.CreateRoundedRectangleGeometry()?;
            let clip = self.compositor.CreateGeometricClipWithGeometry(&geometry)?;
            visual.SetClip(&clip)?;
            visual.SetBrush(&self.compositor.CreateHostBackdropBrush()?)?;
            let interop: ICompositorDesktopInterop = self.compositor.cast()?;
            // The WebView is an HWND child and must remain above this material.
            let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, false)? };
            let surface = Surface {
                target,
                visual,
                geometry,
            };
            self.surfaces.insert(key, surface);
        }
        let surface = self
            .surfaces
            .get(&key)
            .expect("configured composition surface");
        surface.target.SetRoot(&surface.visual)?;
        let size = Vector2 {
            X: width as f32,
            Y: height as f32,
        };
        surface.visual.SetSize(size)?;
        surface.geometry.SetSize(size)?;
        surface.geometry.SetCornerRadius(Vector2 {
            X: radius,
            Y: radius,
        })
    }
}

pub(super) fn configure(hwnd: HWND, width: u32, height: u32, radius: f32) -> Result<()> {
    let result = HOST.with(|host| {
        let mut host = host.borrow_mut();
        if host.is_none() {
            *host = Some(Host::new()?);
        }
        host.as_mut()
            .expect("initialized composition host")
            .configure(hwnd, width, height, radius)
    });
    if result.is_err() {
        release(hwnd);
    }
    result
}

pub(super) fn release(hwnd: HWND) {
    let surface = HOST.with(|host| {
        host.borrow_mut()
            .as_mut()
            .and_then(|host| host.surfaces.remove(&(hwnd.0 as isize)))
    });
    // Close may synchronously dispatch native callbacks. Drop after ending the
    // RefCell borrow so a callback can safely release the same HWND again.
    drop(surface);
}
