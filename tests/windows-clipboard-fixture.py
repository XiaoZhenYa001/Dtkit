"""Bounded clipboard fixture; restores readable memory, bitmap and EMF formats.

The test is skipped when the clipboard contains unsupported handles, or changes
while being backed up. A later user copy is never overwritten during restoration.
"""
import ctypes
import time
from contextlib import contextmanager
from ctypes import wintypes as W

user=ctypes.WinDLL('user32',use_last_error=True)
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
gdi=ctypes.WinDLL('gdi32',use_last_error=True)
user.CopyImage.argtypes=[W.HANDLE,W.UINT,ctypes.c_int,ctypes.c_int,W.UINT];user.CopyImage.restype=W.HANDLE
gdi.DeleteObject.argtypes=[W.HANDLE]
gdi.CopyEnhMetaFileW.argtypes=[W.HANDLE,W.LPCWSTR];gdi.CopyEnhMetaFileW.restype=W.HANDLE
gdi.DeleteEnhMetaFile.argtypes=[W.HANDLE]
user.OpenClipboard.argtypes=[W.HWND];user.OpenClipboard.restype=W.BOOL
user.GetClipboardData.argtypes=[W.UINT];user.GetClipboardData.restype=W.HANDLE
user.SetClipboardData.argtypes=[W.UINT,W.HANDLE];user.SetClipboardData.restype=W.HANDLE
user.EnumClipboardFormats.argtypes=[W.UINT];user.EnumClipboardFormats.restype=W.UINT
user.GetClipboardSequenceNumber.restype=W.DWORD
user.RegisterClipboardFormatW.argtypes=[W.LPCWSTR];user.RegisterClipboardFormatW.restype=W.UINT
user.CreateWindowExW.argtypes=[W.DWORD,W.LPCWSTR,W.LPCWSTR,W.DWORD,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,W.HWND,W.HMENU,W.HINSTANCE,W.LPVOID]
user.CreateWindowExW.restype=W.HWND
user.DestroyWindow.argtypes=[W.HWND]
kernel.GlobalSize.argtypes=[W.HGLOBAL];kernel.GlobalSize.restype=ctypes.c_size_t
kernel.GlobalAlloc.argtypes=[W.UINT,ctypes.c_size_t];kernel.GlobalAlloc.restype=W.HGLOBAL
kernel.GlobalLock.argtypes=[W.HGLOBAL];kernel.GlobalLock.restype=W.LPVOID
kernel.GlobalUnlock.argtypes=[W.HGLOBAL]
kernel.GlobalFree.argtypes=[W.HGLOBAL];kernel.GlobalFree.restype=W.HGLOBAL

class OwnedHandle:
    def __init__(self,value,format):self.value=value;self.format=format
    def close(self):
        if self.value:
            (gdi.DeleteEnhMetaFile if self.format==14 else gdi.DeleteObject)(self.value)
            self.value=None

class Clipboard:
    def __init__(self,owner):self.owner=owner;self.last=None
    def open(self):
        for _ in range(20):
            if user.OpenClipboard(self.owner):return
            time.sleep(.01)
        raise OSError('Clipboard was busy')
    def write(self,formats):
        prepared=[]
        try:
            for fmt,data in formats:
                if isinstance(data,OwnedHandle):
                    prepared.append([fmt,data.value,data]);continue
                memory=kernel.GlobalAlloc(2,max(1,len(data)))
                if not memory:raise MemoryError('Clipboard allocation failed')
                ptr=kernel.GlobalLock(memory)
                if not ptr:kernel.GlobalFree(memory);raise MemoryError('Clipboard lock failed')
                ctypes.memmove(ptr,data,len(data));kernel.GlobalUnlock(memory);prepared.append([fmt,memory,None])
            self.open()
            try:
                assert user.EmptyClipboard()
                for record in prepared:
                    assert user.SetClipboardData(record[0],record[1])
                    if record[2]:record[2].value=None
                    record[1]=None
                self.last=user.GetClipboardSequenceNumber()
            finally:user.CloseClipboard()
        finally:
            for _,memory,owned in prepared:
                if memory and not owned:kernel.GlobalFree(memory)
    def text(self,text,extra=()):self.write([(13,(text+'\0').encode('utf-16-le')),*extra])
    def remember(self):self.last=user.GetClipboardSequenceNumber()

@contextmanager
def preserved_clipboard():
    owner=user.CreateWindowExW(0,'STATIC','DtKit clipboard test',0,0,0,0,0,W.HWND(-3),None,None,None)
    if not owner:raise OSError('Could not create clipboard owner')
    fixture=Clipboard(owner);backup=[];supported=True
    try:
        fixture.open();sequence=user.GetClipboardSequenceNumber()
        try:
            fmt=0;total=0
            while True:
                fmt=user.EnumClipboardFormats(fmt)
                if not fmt:break
                if fmt in (3,9,128):supported=False;break
                memory=user.GetClipboardData(fmt)
                if fmt in (2,14):
                    copied=user.CopyImage(memory,0,0,0,0x2000) if fmt==2 else gdi.CopyEnhMetaFileW(memory,None)
                    if not copied:supported=False;break
                    backup.append((fmt,OwnedHandle(copied,fmt)));continue
                size=kernel.GlobalSize(memory)
                if not memory or not size or size>32*1024*1024:supported=False;break
                total+=size
                if total>64*1024*1024:supported=False;break
                ptr=kernel.GlobalLock(memory)
                if not ptr:supported=False;break
                try:backup.append((fmt,ctypes.string_at(ptr,size)))
                finally:kernel.GlobalUnlock(memory)
            if user.GetClipboardSequenceNumber()!=sequence:supported=False
        finally:user.CloseClipboard()
        yield fixture if supported else None
    finally:
        try:
            if supported and fixture.last is not None and user.GetClipboardSequenceNumber()==fixture.last:fixture.write(backup)
        finally:
            for _,value in backup:
                if isinstance(value,OwnedHandle):value.close()
            user.DestroyWindow(owner)
