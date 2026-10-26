"""A captionless, nonactivating GDI backdrop for native transparency tests."""
import ctypes
from ctypes import wintypes as w
import uuid

class NativeBackdrop:
    def __init__(self, launcher, rect):
        self.user=ctypes.WinDLL('user32',use_last_error=True)
        self.gdi=ctypes.WinDLL('gdi32',use_last_error=True)
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        self.user.SetThreadDpiAwarenessContext.argtypes=[ctypes.c_void_p]
        self.user.SetThreadDpiAwarenessContext.restype=ctypes.c_void_p
        self.previous_dpi=self.user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        self.color=0
        self.split_color=None
        callback=ctypes.WINFUNCTYPE(ctypes.c_ssize_t,w.HWND,w.UINT,w.WPARAM,w.LPARAM)
        self.user.DefWindowProcW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM]
        self.user.DefWindowProcW.restype=ctypes.c_ssize_t
        self.user.GetDC.argtypes=[w.HWND];self.user.GetDC.restype=w.HDC
        self.user.ReleaseDC.argtypes=[w.HWND,w.HDC]
        self.user.GetClientRect.argtypes=[w.HWND,ctypes.POINTER(w.RECT)]
        self.user.FillRect.argtypes=[w.HDC,ctypes.POINTER(w.RECT),w.HBRUSH]
        self.user.ValidateRect.argtypes=[w.HWND,ctypes.c_void_p]
        self.gdi.CreateSolidBrush.argtypes=[w.DWORD];self.gdi.CreateSolidBrush.restype=w.HBRUSH
        self.gdi.DeleteObject.argtypes=[w.HBRUSH]
        def procedure(hwnd,message,wp,lp):
            if message==0x000f:
                self.paint(hwnd);self.user.ValidateRect(hwnd,None);return 0
            if message==0x0014:return 1
            return self.user.DefWindowProcW(hwnd,message,wp,lp)
        self.procedure=callback(procedure)
        class WindowClass(ctypes.Structure):
            _fields_=[('style',w.UINT),('procedure',callback),('classExtra',ctypes.c_int),('windowExtra',ctypes.c_int),
                ('instance',w.HINSTANCE),('icon',w.HICON),('cursor',w.HANDLE),('brush',w.HBRUSH),('menu',w.LPCWSTR),('name',w.LPCWSTR)]
        kernel.GetModuleHandleW.argtypes=[w.LPCWSTR];kernel.GetModuleHandleW.restype=w.HINSTANCE
        self.instance=kernel.GetModuleHandleW(None)
        self.name='DtKitGlassTest-'+uuid.uuid4().hex
        definition=WindowClass();definition.procedure=self.procedure;definition.instance=self.instance;definition.name=self.name
        self.user.RegisterClassW.argtypes=[ctypes.POINTER(WindowClass)]
        assert self.user.RegisterClassW(ctypes.byref(definition)),ctypes.get_last_error()
        self.user.CreateWindowExW.argtypes=[w.DWORD,w.LPCWSTR,w.LPCWSTR,w.DWORD,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,w.HWND,w.HMENU,w.HINSTANCE,ctypes.c_void_p]
        self.user.CreateWindowExW.restype=w.HWND
        # Tool + no-activate + topmost; position immediately behind this test HWND.
        self.hwnd=self.user.CreateWindowExW(0x08000088,self.name,'',0x80000000,rect.left-20,rect.top-20,
            rect.right-rect.left+40,rect.bottom-rect.top+40,None,None,self.instance,None)
        assert self.hwnd,ctypes.get_last_error()
        self.user.SetWindowPos.argtypes=[w.HWND,w.HWND,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,w.UINT]
        assert self.user.SetWindowPos(self.hwnd,launcher,rect.left-20,rect.top-20,rect.right-rect.left+40,rect.bottom-rect.top+40,0x0050)

    def paint(self,hwnd=None):
        hwnd=hwnd or self.hwnd
        dc=self.user.GetDC(hwnd);brush=self.gdi.CreateSolidBrush(self.color)
        try:
            rect=w.RECT();self.user.GetClientRect(hwnd,ctypes.byref(rect));self.user.FillRect(dc,ctypes.byref(rect),brush)
            if self.split_color is not None:
                right_brush=self.gdi.CreateSolidBrush(self.split_color)
                try:
                    rect.left=rect.right//2;self.user.FillRect(dc,ctypes.byref(rect),right_brush)
                finally:self.gdi.DeleteObject(right_brush)
        finally:self.gdi.DeleteObject(brush);self.user.ReleaseDC(hwnd,dc)

    def set_color(self,color):
        r,g,b=color
        self.color=r|(g<<8)|(b<<16);self.split_color=None;self.paint()

    def set_split_color(self,left,right):
        self.color=left[0]|(left[1]<<8)|(left[2]<<16)
        self.split_color=right[0]|(right[1]<<8)|(right[2]<<16)
        self.paint()

    def close(self):
        self.user.DestroyWindow.argtypes=[w.HWND]
        self.user.UnregisterClassW.argtypes=[w.LPCWSTR,w.HINSTANCE]
        self.user.DestroyWindow(self.hwnd);self.user.UnregisterClassW(self.name,self.instance)
        if self.previous_dpi:self.user.SetThreadDpiAwarenessContext(self.previous_dpi)
