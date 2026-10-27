//! A desktop backdrop visual whose sampled pixels share the WebView's outline.
//! The Accent blur policy paints a separate rectangle even outside SetWindowRgn.
use std::{cell::RefCell, collections::HashMap, mem::size_of};
use windows::{
    core::{Interface, Result, HSTRING},
    Foundation::{
        Numerics::{Vector2, Vector3},
        TimeSpan,
    },
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
        surface.visual.SetCenterPoint(Vector3 {
            X: size.X / 2.0,
            Y: size.Y / 2.0,
            Z: 0.0,
        })?;
        surface.geometry.SetSize(size)?;
        surface.geometry.SetCornerRadius(Vector2 {
            X: radius,
            Y: radius,
        })
    }

    fn prepare_open(&self, hwnd: HWND, fresh: bool, shift: f32, reduced: bool) -> Result<()> {
        let Some(surface) = self.surfaces.get(&(hwnd.0 as isize)) else {
            return Ok(());
        };
        if fresh {
            for property in ["Opacity", "Scale", "Offset"] {
                surface.visual.StopAnimation(&HSTRING::from(property))?;
            }
            surface.visual.SetOpacity(0.0)?;
            surface.visual.SetScale(Vector3 {
                X: if reduced { 1.0 } else { 0.975 },
                Y: if reduced { 1.0 } else { 0.975 },
                Z: 1.0,
            })?;
            surface.visual.SetOffset(Vector3 {
                X: 0.0,
                Y: if reduced { 0.0 } else { shift },
                Z: 0.0,
            })?;
        }
        Ok(())
    }

    fn animate_visibility(
        &self,
        hwnd: HWND,
        visible: bool,
        shift: f32,
        reduced: bool,
    ) -> Result<()> {
        let Some(surface) = self.surfaces.get(&(hwnd.0 as isize)) else {
            return Ok(());
        };
        let opacity = if visible { 1.0 } else { 0.0 };
        let scale = if visible || reduced { 1.0 } else { 0.975 };
        let offset = Vector3 {
            X: 0.0,
            Y: if visible || reduced { 0.0 } else { shift },
            Z: 0.0,
        };
        if reduced {
            for property in ["Opacity", "Scale", "Offset"] {
                surface.visual.StopAnimation(&HSTRING::from(property))?;
            }
            surface.visual.SetOpacity(opacity)?;
            surface.visual.SetScale(Vector3 {
                X: scale,
                Y: scale,
                Z: 1.0,
            })?;
            return surface.visual.SetOffset(offset);
        }
        let duration = TimeSpan {
            Duration: if visible { 220 } else { 180 } * 10_000,
        };
        let easing = self.compositor.CreateCubicBezierEasingFunction(
            Vector2 { X: 0.23, Y: 1.0 },
            Vector2 { X: 0.32, Y: 1.0 },
        )?;
        let animation = self.compositor.CreateScalarKeyFrameAnimation()?;
        animation.SetDuration(duration)?;
        animation.InsertExpressionKeyFrame(0.0, &HSTRING::from("this.StartingValue"))?;
        animation.InsertKeyFrameWithEasingFunction(1.0, opacity, &easing)?;
        // StartingValue is evaluated by the compositor from the presented value,
        // so a quick reversal does not jump back to an animation's first frame.
        surface
            .visual
            .StartAnimation(&HSTRING::from("Opacity"), &animation)?;
        for (property, value) in [
            (
                "Scale",
                Vector3 {
                    X: scale,
                    Y: scale,
                    Z: 1.0,
                },
            ),
            ("Offset", offset),
        ] {
            let animation = self.compositor.CreateVector3KeyFrameAnimation()?;
            animation.SetDuration(duration)?;
            animation.InsertExpressionKeyFrame(0.0, &HSTRING::from("this.StartingValue"))?;
            animation.InsertKeyFrameWithEasingFunction(1.0, value, &easing)?;
            surface
                .visual
                .StartAnimation(&HSTRING::from(property), &animation)?;
        }
        Ok(())
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

pub(super) fn prepare_open(hwnd: HWND, fresh: bool, shift: f32, reduced: bool) -> Result<()> {
    HOST.with(|host| match host.borrow().as_ref() {
        Some(host) => host.prepare_open(hwnd, fresh, shift, reduced),
        None => Ok(()),
    })
}

pub(super) fn animate_visibility(
    hwnd: HWND,
    visible: bool,
    shift: f32,
    reduced: bool,
) -> Result<()> {
    HOST.with(|host| match host.borrow().as_ref() {
        Some(host) => host.animate_visibility(hwnd, visible, shift, reduced),
        None => Ok(()),
    })
}
