#![no_std]
#![no_main]

use core::panic::PanicInfo;

#[repr(C)]
struct IoVec {
    buffer: *mut u8,
    length: usize,
}

#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn args_sizes_get(count: *mut usize, bytes: *mut usize) -> u16;
    fn args_get(pointers: *mut *mut u8, bytes: *mut u8) -> u16;
    fn fd_read(fd: u32, vectors: *const IoVec, count: usize, read: *mut usize) -> u16;
    fn fd_write(fd: u32, vectors: *const IoVec, count: usize, written: *mut usize) -> u16;
    fn fd_close(fd: u32) -> u16;
    fn path_open(
        fd: u32,
        dir_flags: u32,
        path: *const u8,
        path_len: usize,
        open_flags: u16,
        rights_base: u64,
        rights_inheriting: u64,
        fd_flags: u16,
        opened_fd: *mut u32,
    ) -> u16;
    fn proc_exit(code: u32) -> !;
}

#[no_mangle]
pub extern "C" fn _start() {
    let mode = first_user_argument();
    match mode {
        b'w' => workspace_round_trip(),
        b'f' => fail_with_status(),
        b'l' => {
            write_fd(1, b"rust-cancel-ready\n");
            loop { core::hint::spin_loop(); }
        }
        _ => write_fd(1, b"rust-wasi-ready\n"),
    }
}

fn first_user_argument() -> u8 {
    let mut count = 0usize;
    let mut bytes_needed = 0usize;
    unsafe {
        if args_sizes_get(&mut count, &mut bytes_needed) != 0 || count < 2 || count > 8 || bytes_needed > 128 {
            return 0;
        }
        let mut pointers = [core::ptr::null_mut(); 8];
        let mut bytes = [0u8; 128];
        if args_get(pointers.as_mut_ptr(), bytes.as_mut_ptr()) != 0 || pointers[1].is_null() {
            return 0;
        }
        *pointers[1]
    }
}

fn workspace_round_trip() {
    let mut input = 0u32;
    let input_path = b"input.txt";
    unsafe {
        if path_open(3, 0, input_path.as_ptr(), input_path.len(), 0, 2, 0, 0, &mut input) != 0 {
            proc_exit(41);
        }
    }
    let mut content = [0u8; 256];
    let mut read = 0usize;
    let read_vector = IoVec { buffer: content.as_mut_ptr(), length: content.len() };
    unsafe {
        if fd_read(input, &read_vector, 1, &mut read) != 0 { proc_exit(42); }
        fd_close(input);
    }
    write_fd(1, b"rust-stdout:workspace\n");
    write_fd(2, b"rust-stderr:workspace\n");
    let mut output = 0u32;
    let output_path = b"output.txt";
    unsafe {
        if path_open(3, 0, output_path.as_ptr(), output_path.len(), 9, 64, 0, 0, &mut output) != 0 {
            proc_exit(43);
        }
    }
    write_fd(output, &content[..read]);
    unsafe { fd_close(output); }
}

fn fail_with_status() {
    write_fd(1, b"rust-before-failure\n");
    write_fd(2, b"rust-failure-detail\n");
    let mut output = 0u32;
    let path = b"must-not-adopt.txt";
    unsafe {
        if path_open(3, 0, path.as_ptr(), path.len(), 9, 64, 0, 0, &mut output) == 0 {
            write_fd(output, b"failed command output\n");
            fd_close(output);
        }
        proc_exit(23);
    }
}

fn write_fd(fd: u32, bytes: &[u8]) {
    let vector = IoVec { buffer: bytes.as_ptr() as *mut u8, length: bytes.len() };
    let mut written = 0usize;
    unsafe { fd_write(fd, &vector, 1, &mut written); }
}

#[panic_handler]
fn panic(_: &PanicInfo<'_>) -> ! {
    unsafe { proc_exit(101) }
}

