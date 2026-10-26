import { fileURLToPath, URL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const pdfResources = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

// Keep PDF decoding, standard fonts and CJK character maps available offline.
function localPdfResources() {
    const resourceRoot = join(projectRoot, 'node_modules', 'pdfjs-dist');
    return {
        name: 'dtkit-local-pdf-resources',
        generateBundle() {
            for (const directory of pdfResources) for (const file of readdirSync(join(resourceRoot, directory), { withFileTypes: true })) {
                if (!file.isFile()) continue;
                this.emitFile({ type: 'asset', fileName: `pdfjs/${directory}/${file.name}`, source: readFileSync(join(resourceRoot, directory, file.name)) });
            }
        },
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                const match = /^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([a-zA-Z0-9_.-]+)$/.exec((request.url || '').split('?')[0]);
                if (!match || match[2].includes('..')) return next();
                try {
                    const content = readFileSync(join(resourceRoot, match[1], match[2]));
                    response.setHeader('Content-Type', match[2].endsWith('.wasm') ? 'application/wasm' : match[2].endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
                    response.end(content);
                } catch { next(); }
            });
        }
    };
}

export default defineConfig({
    plugins: [localPdfResources()],
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
                toolPage: `${projectRoot}src/tool-page.html`,
                stickyNote: `${projectRoot}src/sticky-note.html`,
                timetableWidget: `${projectRoot}src/timetable-widget.html`,
                colorPicker: `${projectRoot}src/color-pick.html`,
                screenRegion: `${projectRoot}src/screen-region.html`,
                longCaptureBorder: `${projectRoot}src/long-capture-border.html`,
                desktopOrganizer: `${projectRoot}src/desktop-organizer/index.html`,
                desktopSpace: `${projectRoot}src/desktop-organizer/space.html`
            }
        }
    }
});
