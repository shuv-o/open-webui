// Bundles Tesseract.js (WASM OCR engine) into static/tesseract/ so the Pyodide
// code interpreter sandbox can load it fully offline, with no CDN dependency,
// mirroring how prepare-pyodide.js bundles the Pyodide runtime itself.

const LANGUAGES = ['eng', 'ben'];
const TESSDATA_BASE_URL = 'https://tessdata.projectnaptha.com/4.0.0';

const STATIC_DIR = 'static/tesseract';
const CORE_DIR = `${STATIC_DIR}/core`;
const LANG_DIR = `${STATIC_DIR}/lang-data`;

import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { mkdir, copyFile, writeFile, access, readdir } from 'fs/promises';

/**
 * Loading network proxy configurations from the environment variables.
 * And the proxy config with lowercase name has the highest priority to use.
 */
function initNetworkProxyFromEnv() {
	// we assume all subsequent requests in this script are HTTPS:
	// https://tessdata.projectnaptha.com
	const allProxy = process.env.all_proxy || process.env.ALL_PROXY;
	const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
	const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
	const preferedProxy = httpsProxy || allProxy || httpProxy;
	if (!preferedProxy || !preferedProxy.startsWith('http')) return;
	let preferedProxyURL;
	try {
		preferedProxyURL = new URL(preferedProxy).toString();
	} catch {
		console.warn(`Invalid network proxy URL: "${preferedProxy}"`);
		return;
	}
	setGlobalDispatcher(new ProxyAgent({ uri: preferedProxyURL }));
	console.log(`Initialized network proxy "${preferedProxy}" from env`);
}

async function copyWorkerAssets() {
	console.log('Copying Tesseract.js worker + core assets');
	await mkdir(STATIC_DIR, { recursive: true });
	await copyFile('node_modules/tesseract.js/dist/tesseract.min.js', `${STATIC_DIR}/tesseract.min.js`);
	await copyFile('node_modules/tesseract.js/dist/worker.min.js', `${STATIC_DIR}/worker.min.js`);

	// Copy every WASM core variant (plain/simd/relaxedsimd x full/lstm-only) —
	// getCore.js picks one at runtime based on feature-detecting the browser's
	// WASM support, so all of them need to be present.
	await mkdir(CORE_DIR, { recursive: true });
	const coreSrcDir = 'node_modules/tesseract.js-core';
	const coreFiles = (await readdir(coreSrcDir)).filter((f) => f.endsWith('.wasm') || f.endsWith('.wasm.js'));
	for (const file of coreFiles) {
		await copyFile(`${coreSrcDir}/${file}`, `${CORE_DIR}/${file}`);
	}
}

async function downloadLangData() {
	console.log('Downloading OCR language data:', LANGUAGES);
	await mkdir(LANG_DIR, { recursive: true });

	for (const lang of LANGUAGES) {
		const dest = `${LANG_DIR}/${lang}.traineddata.gz`;
		try {
			await access(dest);
			console.log(`  Already exists: ${lang}.traineddata.gz`);
			continue;
		} catch {
			// not present yet, fall through to download
		}

		console.log(`  Downloading: ${lang}.traineddata.gz`);
		const res = await fetch(`${TESSDATA_BASE_URL}/${lang}.traineddata.gz`);
		if (!res.ok) {
			throw new Error(`Failed to download ${lang}.traineddata.gz: HTTP ${res.status}`);
		}
		const buffer = Buffer.from(await res.arrayBuffer());
		await writeFile(dest, buffer);
		console.log(`  Saved: ${dest} (${buffer.length} bytes)`);
	}
}

try {
	initNetworkProxyFromEnv();
	await copyWorkerAssets();
	await downloadLangData();
	console.log('Tesseract.js OCR assets ready.');
} catch (err) {
	console.error('Failed to prepare Tesseract.js OCR assets:', err);
	process.exit(1);
}
