// 桌面整理模块
// Desktop Organizer Module

pub mod apps;
pub(crate) mod classic_motion;
pub mod commands;
pub mod hotzone;
pub mod scanner;
pub(crate) mod space;
pub(crate) mod space_settings;
pub(crate) mod space_surface;

#[cfg(windows)]
pub mod icon;
