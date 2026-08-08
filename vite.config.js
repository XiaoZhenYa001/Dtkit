import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: fileURLToPath(new URL('./src', import.meta.url)),
    base: './',
    server: {
        host: '127.0.0.1',
        port: 1420,
        strictPort: true
    },
    build: {
        outDir: fileURLToPath(new URL('./dist', import.meta.url)),
        emptyOutDir: true,
        sourcemap: false,
        rollupOptions: {
            input: {
                main: `${projectRoot}src/index.html`,
                quick: `${projectRoot}src/quick.html`,
                colorPicker: `${projectRoot}src/color-pick.html`,
                screenRegion: `${projectRoot}src/screen-region.html`,
                longCaptureBorder: `${projectRoot}src/long-capture-border.html`,
                desktopOrganizer: `${projectRoot}src/desktop-organizer/index.html`
            }
        }
    }
});
