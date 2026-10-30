//! DXGI Desktop Duplication frame source for the clip recorder.
//!
//! The GDI path (`screenshot_capture::capture_frame_jpeg`) reads the whole
//! desktop with `BitBlt` on every frame, which costs 26–46 ms at 2560×1600 and
//! caps the recorder near 20 fps. Desktop Duplication hands us a GPU texture
//! instead: the copy is a `CopyResource` into a staging texture, so the CPU only
//! pays for the row copy, scaling and JPEG encode.
//!
//! This is the first half of the 60/120 recorder. The MJPEG writer stays as the
//! fallback, and a machine where duplication is unavailable (remote session,
//! older driver, secure desktop) keeps using GDI without changing the clip list
//! or the AVI container.

#[cfg(windows)]
mod imp {
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    use image::{ExtendedColorType, RgbImage};
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::{
        IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource, DXGI_OUTDUPL_FRAME_INFO,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Foundation::HMODULE;

    pub struct DxgiCapture {
        context: ID3D11DeviceContext,
        duplication: IDXGIOutputDuplication,
        staging: ID3D11Texture2D,
        width: u32,
        height: u32,
    }

    impl DxgiCapture {
        /// Opens duplication on output 0 of the default adapter. `None` means
        /// the caller keeps the GDI path.
        pub fn open() -> Option<DxgiCapture> {
            unsafe {
                let mut device: Option<ID3D11Device> = None;
                let mut context: Option<ID3D11DeviceContext> = None;
                let mut level = D3D_FEATURE_LEVEL_11_0;
                if D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&[D3D_FEATURE_LEVEL_11_0]),
                    windows::Win32::Graphics::Direct3D11::D3D11_SDK_VERSION,
                    Some(&mut device),
                    Some(&mut level),
                    Some(&mut context),
                )
                .is_err()
                {
                    return None;
                }
                let device = device?;
                let context = context?;
                let dxgi_device = device.cast::<windows::Win32::Graphics::Dxgi::IDXGIDevice>().ok()?;
                let adapter = dxgi_device.GetAdapter().ok()?;
                let output = adapter.EnumOutputs(0).ok()?;
                let output1 = output.cast::<IDXGIOutput1>().ok()?;
                let duplication = output1.DuplicateOutput(&device).ok()?;

                let desc = duplication.GetDesc();
                let width = desc.ModeDesc.Width;
                let height = desc.ModeDesc.Height;
                if width == 0 || height == 0 {
                    return None;
                }
                let staging_desc = D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut staging: Option<ID3D11Texture2D> = None;
                if device
                    .CreateTexture2D(&staging_desc, None, Some(&mut staging))
                    .is_err()
                {
                    return None;
                }
                Some(DxgiCapture {
                    context,
                    duplication,
                    staging: staging?,
                    width,
                    height,
                })
            }
        }

        /// Grabs the newest desktop frame as top-down BGRA. `None` means no new
        /// frame arrived inside the timeout; the caller skips this tick instead
        /// of paying for a second GDI read.
        pub fn frame_bgra(&mut self) -> Option<(Vec<u8>, u32, u32)> {
            unsafe {
                let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;
                if self
                    .duplication
                    .AcquireNextFrame(0, &mut info, &mut resource)
                    .is_err()
                {
                    return None;
                }
                let texture = resource?.cast::<ID3D11Texture2D>().ok()?;
                self.context.CopyResource(&self.staging, &texture);
                let _ = self.duplication.ReleaseFrame();

                let mut mapped = Default::default();
                if self
                    .context
                    .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                    .is_err()
                {
                    return None;
                }
                let row_pitch = mapped.RowPitch as usize;
                let width = self.width as usize;
                let height = self.height as usize;
                let mut bgra = vec![0u8; width * height * 4];
                let source = std::slice::from_raw_parts(mapped.pData as *const u8, row_pitch * height);
                for row in 0..height {
                    let src = &source[row * row_pitch..row * row_pitch + width * 4];
                    bgra[row * width * 4..(row + 1) * width * 4].copy_from_slice(src);
                }
                self.context.Unmap(&self.staging, 0);
                Some((bgra, self.width, self.height))
            }
        }

        /// The MJPEG path: the same frame scaled and JPEG-encoded.
        pub fn frame_jpeg(&mut self, quality: u8, target_height: u32) -> Option<(Vec<u8>, u32, u32)> {
            let (bgra, width, height) = self.frame_bgra()?;
            let mut rgb = RgbImage::new(width, height);
            for (pixel, source) in rgb.pixels_mut().zip(bgra.chunks_exact(4)) {
                *pixel = image::Rgb([source[2], source[1], source[0]]);
            }
            let (out_w, out_h) = scaled_size(width, height, target_height);
            let image = if out_w != width || out_h != height {
                image::imageops::resize(&rgb, out_w, out_h, FilterType::Triangle)
            } else {
                rgb
            };
            let mut jpeg = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut jpeg, quality.clamp(1, 100));
            encoder
                .encode(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgb8)
                .ok()?;
            Some((jpeg, image.width(), image.height()))
        }
    }

    pub(super) fn scaled_size(width: u32, height: u32, target_height: u32) -> (u32, u32) {
        if target_height == 0 || height <= target_height {
            return (width, height);
        }
        let out_h = target_height;
        let out_w = ((width as u64 * out_h as u64) / height as u64).max(2) as u32;
        (out_w & !1, out_h & !1)
    }
}

#[cfg(windows)]
pub use imp::DxgiCapture;

#[cfg(not(windows))]
pub struct DxgiCapture;

#[cfg(not(windows))]
impl DxgiCapture {
    pub fn open() -> Option<DxgiCapture> {
        None
    }
    pub fn frame_jpeg(&mut self, _quality: u8, _target_height: u32) -> Option<(Vec<u8>, u32, u32)> {
        None
    }
    pub fn frame_bgra(&mut self) -> Option<(Vec<u8>, u32, u32)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn a_target_height_keeps_the_aspect_and_even_dimensions() {
        assert_eq!(imp::scaled_size(2560, 1600, 720), (1152, 720));
        assert_eq!(imp::scaled_size(1920, 1080, 720), (1280, 720));
        assert_eq!(imp::scaled_size(1280, 720, 0), (1280, 720));
        assert_eq!(imp::scaled_size(1280, 720, 1080), (1280, 720));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a real desktop and a GPU with Desktop Duplication"]
    fn duplication_returns_a_desktop_frame() {
        let mut capture = super::DxgiCapture::open().expect("open desktop duplication");
        let (bgra, width, height) = capture.frame_bgra().expect("desktop frame");
        assert!(width > 0 && height > 0);
        assert_eq!(bgra.len(), width as usize * height as usize * 4);
    }
}
