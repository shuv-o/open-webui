const packages = [
	'micropip',
	'packaging',
	'requests',
	'beautifulsoup4',
	'numpy',
	'pandas',
	'matplotlib',
	'scikit-learn',
	'scipy',
	'regex',
	'sympy',
	'tiktoken',
	'seaborn',
	'pytz',
	'black',
	'openai'
];

// Pure-Python packages whose wheels must be downloaded from PyPI and saved into
// static/pyodide/ so that the browser can install them offline via micropip.
// Packages already provided by the Pyodide distribution (click, platformdirs,
// typing_extensions, etc.) do NOT need to be listed here — only packages absent
// from Pyodide's own package repository need this treatment. openpyxl,
// python-docx, and python-pptx are all absent from that repository (confirmed
// via micropip.freeze() during development — they install fine at build time
// over the network but vanish from the frozen lock file), so unlike Pyodide's
// own packages they'd otherwise require a live PyPI fetch from the *browser* at
// chat time. et-xmlfile and XlsxWriter are pulled in here too since they're
// runtime dependencies of openpyxl/python-pptx that are likewise absent from
// Pyodide's repository.
const pypiPackages = [
	'black',
	'pathspec',
	'mypy_extensions',
	'pytokens',
	'openpyxl',
	'et-xmlfile',
	'python-docx',
	'python-pptx',
	'xlsxwriter'
];

// A handful of packages have a PyPI/pip name that differs from the Python
// import name their wheel actually provides — the pyodide-lock.json `imports`
// field must reflect the real import name (mirrors how Pyodide's own native
// packages, e.g. beautifulsoup4 -> bs4, record this).
const importNameOverrides = {
	'python-docx': 'docx',
	'python-pptx': 'pptx'
};

import { loadPyodide } from 'pyodide';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { writeFile, readFile, copyFile, readdir, rmdir, access } from 'fs/promises';

/**
 * Loading network proxy configurations from the environment variables.
 * And the proxy config with lowercase name has the highest priority to use.
 */
function initNetworkProxyFromEnv() {
	// we assume all subsequent requests in this script are HTTPS:
	// https://cdn.jsdelivr.net
	// https://pypi.org
	// https://files.pythonhosted.org
	const allProxy = process.env.all_proxy || process.env.ALL_PROXY;
	const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
	const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
	const preferedProxy = httpsProxy || allProxy || httpProxy;
	/**
	 * use only http(s) proxy because socks5 proxy is not supported currently:
	 * @see https://github.com/nodejs/undici/issues/2224
	 */
	if (!preferedProxy || !preferedProxy.startsWith('http')) return;
	let preferedProxyURL;
	try {
		preferedProxyURL = new URL(preferedProxy).toString();
	} catch {
		console.warn(`Invalid network proxy URL: "${preferedProxy}"`);
		return;
	}
	const dispatcher = new ProxyAgent({ uri: preferedProxyURL });
	setGlobalDispatcher(dispatcher);
	console.log(`Initialized network proxy "${preferedProxy}" from env`);
}

async function downloadPackages() {
	console.log('Setting up pyodide + micropip');

	let pyodide;
	try {
		pyodide = await loadPyodide({
			packageCacheDir: 'static/pyodide'
		});
	} catch (err) {
		console.error('Failed to load Pyodide:', err);
		return;
	}

	const packageJson = JSON.parse(await readFile('package.json'));
	const pyodideVersion = packageJson.dependencies.pyodide.replace('^', '');

	try {
		const pyodidePackageJson = JSON.parse(await readFile('static/pyodide/package.json'));
		const pyodidePackageVersion = pyodidePackageJson.version.replace('^', '');

		if (pyodideVersion !== pyodidePackageVersion) {
			console.log('Pyodide version mismatch, removing static/pyodide directory');
			await rmdir('static/pyodide', { recursive: true });
		}
	} catch (err) {
		console.log('Pyodide package not found, proceeding with download.', err);
	}

	try {
		console.log('Loading micropip package');
		await pyodide.loadPackage('micropip');

		const micropip = pyodide.pyimport('micropip');
		console.log('Downloading Pyodide packages:', packages);

		try {
			for (const pkg of packages) {
				console.log(`Installing package: ${pkg}`);
				await micropip.install(pkg);
			}
		} catch (err) {
			console.error('Package installation failed:', err);
			return;
		}

		console.log('Pyodide packages downloaded, freezing into lock file');

		try {
			const lockFile = await micropip.freeze();
			await writeFile('static/pyodide/pyodide-lock.json', lockFile);
		} catch (err) {
			console.error('Failed to write lock file:', err);
		}
	} catch (err) {
		console.error('Failed to load or install micropip:', err);
	}
}

async function copyPyodide() {
	console.log('Copying Pyodide files into static directory');
	// Copy all files from node_modules/pyodide to static/pyodide
	for await (const entry of await readdir('node_modules/pyodide')) {
		await copyFile(`node_modules/pyodide/${entry}`, `static/pyodide/${entry}`);
	}
}

/**
 * Download pure-Python wheels from PyPI and save them into static/pyodide/.
 * Also injects entries into pyodide-lock.json so that micropip resolves these
 * packages from the local server instead of fetching them from the internet.
 */
async function downloadPyPIWheels() {
	const lockPath = 'static/pyodide/pyodide-lock.json';
	let lockData;
	try {
		lockData = JSON.parse(await readFile(lockPath, 'utf-8'));
	} catch {
		console.warn('Could not read pyodide-lock.json, skipping PyPI wheel download');
		return;
	}

	for (const pkg of pypiPackages) {
		console.log(`Fetching PyPI metadata for: ${pkg}`);
		const res = await fetch(`https://pypi.org/pypi/${pkg}/json`);
		if (!res.ok) {
			console.error(`Failed to fetch PyPI metadata for ${pkg}: ${res.status}`);
			continue;
		}
		const meta = await res.json();
		const version = meta.info.version;
		const files = meta.urls || [];
		// Find the pure-Python wheel (py3-none-any)
		const wheel = files.find(
			(f) => f.filename.endsWith('.whl') && f.filename.includes('py3-none-any')
		);
		if (!wheel) {
			console.warn(`No pure-Python wheel found for ${pkg}==${version}, skipping`);
			continue;
		}
		const dest = `static/pyodide/${wheel.filename}`;
		// Download wheel if not already present
		try {
			await access(dest);
			console.log(`  Already exists: ${wheel.filename}`);
		} catch {
			console.log(`  Downloading: ${wheel.filename}`);
			const wheelRes = await fetch(wheel.url);
			if (!wheelRes.ok) {
				console.error(`  Failed to download ${wheel.filename}: ${wheelRes.status}`);
				continue;
			}
			const buffer = Buffer.from(await wheelRes.arrayBuffer());
			await writeFile(dest, buffer);
			console.log(`  Saved: ${dest} (${buffer.length} bytes)`);
		}

		// Runtime dependencies (skipping optional "extras"). micropip resolves a
		// `depends` entry by looking it up as a dict key in pyodide-lock.json's
		// `packages` object, after canonicalizing it PEP 503-style (lowercase,
		// runs of "-_." collapsed to a single "-"). Verified empirically: a key
		// stored in underscore form (e.g. "et_xmlfile") is NEVER matched, because
		// canonicalization only ever folds towards hyphens, never the reverse —
		// so the dict key below MUST be canonicalized the same way, not just
		// have hyphens swapped for underscores (the previous, incorrect version
		// of this script did that, silently breaking `depends` lookups for any
		// dependency name PyPI declares with a hyphen).
		// IMPORTANT: an empty `depends` here silently ships a package that
		// imports fine at the top level but throws ModuleNotFoundError the
		// moment it touches a submodule needing the missing dependency — this
		// bit openpyxl (needs et-xmlfile) and python-pptx (needs Pillow,
		// XlsxWriter) during testing, so this must stay accurate.
		const canonicalize = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
		const depends = (meta.info.requires_dist || [])
			.filter((req) => !req.includes(';') || !req.includes('extra =='))
			.map((req) => req.split(/[\s<>=!~;[]/)[0].trim())
			.filter(Boolean)
			.map(canonicalize);

		// Inject into pyodide-lock.json so micropip resolves locally.
		const canonicalName = canonicalize(pkg);
		if (!lockData.packages[canonicalName]) {
			lockData.packages[canonicalName] = {
				name: pkg,
				version: version,
				file_name: wheel.filename,
				install_dir: 'site',
				sha256: wheel.digests?.sha256 || '',
				package_type: 'package',
				imports: [importNameOverrides[pkg] || pkg.replace(/-/g, '_')],
				depends: depends
			};
			console.log(
				`  Added ${pkg}==${version} to pyodide-lock.json (depends: ${depends.join(', ') || 'none'})`
			);
		}
	}

	await writeFile(lockPath, JSON.stringify(lockData, null, 2));
	console.log('Updated pyodide-lock.json with PyPI packages');
}

initNetworkProxyFromEnv();
await downloadPackages();
await copyPyodide();
await downloadPyPIWheels();
