export async function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function ensureTrailingSlash(url) {
  if (!url) return './';
  return url.endsWith('/') ? url : `${url}/`;
}

export async function loadSiteConfig(configUrl = './config.json', timeoutMs = 3000) {
  const res = await fetchWithTimeout(configUrl, timeoutMs);
  if (!res.ok) {
    throw new Error(`無法讀取設定檔 ${configUrl}（HTTP ${res.status}）`);
  }
  return res.json();
}

export function extractJsonFilenamesFromHtml(htmlText, excludeNames = []) {
  const excluded = new Set(excludeNames.map(n => n.toLowerCase()));
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const names = new Set();

  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const cleanHref = href.split('?')[0].split('#')[0];
    if (!cleanHref.toLowerCase().endsWith('.json')) return;
    const parts = cleanHref.split('/').filter(Boolean);
    const filename = parts[parts.length - 1];
    if (filename && !filename.startsWith('.') && !excluded.has(filename.toLowerCase())) {
      names.add(decodeURIComponent(filename));
    }
  });

  return Array.from(names);
}

export async function loadJsonFromSource({
  baseUrl,
  manifestFile = 'manifest.json',
  explicitFiles = [],
  scanTimeoutMs = 1500,
  fileTimeoutMs = 4000,
  allowManifest = true,
  normalizeFn
}) {
  const rootUrl = ensureTrailingSlash(baseUrl);
  const excludes = manifestFile ? [manifestFile] : [];

  let filenames = [];
  if (Array.isArray(explicitFiles) && explicitFiles.length > 0) {
    filenames = explicitFiles.filter(
      name => typeof name === 'string' && name.toLowerCase().endsWith('.json')
    );
  } else {
    const dirPromise = (async () => {
      const res = await fetchWithTimeout(rootUrl, scanTimeoutMs);
      if (!res.ok) throw new Error(`無法讀取 ${rootUrl}（HTTP ${res.status}）`);
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      if (contentType.includes('text/html') || text.includes('<a href=')) {
        const names = extractJsonFilenamesFromHtml(text, excludes);
        if (names.length > 0) return names;
      }
      throw new Error(`${rootUrl} 無可解析的 JSON 目錄列表`);
    })();

    let discoverPromise = dirPromise;
    if (allowManifest && manifestFile) {
      const manifestPromise = (async () => {
        const res = await fetchWithTimeout(`${rootUrl}${manifestFile}`, scanTimeoutMs);
        if (!res.ok) throw new Error('manifest not ok');
        const manifest = await res.json();
        if (!Array.isArray(manifest)) throw new Error('invalid manifest');
        return manifest.filter(
          name => typeof name === 'string' &&
            name.toLowerCase().endsWith('.json') &&
            !excludes.includes(name.toLowerCase())
        );
      })();
      discoverPromise = Promise.any([dirPromise, manifestPromise]);
    }

    filenames = await discoverPromise;
  }

  const sortedNames = Array.from(new Set(filenames)).sort((a, b) => a.localeCompare(b));
  const itemsMap = new Map();
  const errors = [];

  const results = await Promise.allSettled(
    sortedNames.map(async filename => {
      const url = `${rootUrl}${encodeURIComponent(filename)}`;
      const res = await fetchWithTimeout(url, fileTimeoutMs);
      if (!res.ok) throw new Error(`${filename}（HTTP ${res.status}）`);
      const parsed = await res.json();
      return { filename, url, normalized: normalizeFn(parsed, filename) };
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      itemsMap.set(r.value.filename, {
        name: r.value.filename,
        url: r.value.url,
        ...r.value.normalized
      });
    } else {
      errors.push(r.reason?.message || '未知錯誤');
    }
  }

  return { itemsMap, errors, resolvedBaseUrl: rootUrl };
}

export async function parseManualJsonFiles(fileList, normalizeFn, excludeNames = []) {
  const excluded = new Set(excludeNames.map(n => n.toLowerCase()));
  const jsonFiles = Array.from(fileList)
    .filter(f => f.name.toLowerCase().endsWith('.json') && !excluded.has(f.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b));

  if (jsonFiles.length === 0) {
    return { parsedList: [], errors: ['所選檔案中沒有有效的 <code>.json</code> 檔案。'] };
  }

  const results = await Promise.allSettled(
    jsonFiles.map(async file => {
      const text = await file.text();
      const parsed = JSON.parse(text);
      return { filename: file.name, normalized: normalizeFn(parsed, file.name) };
    })
  );

  const parsedList = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      parsedList.push(r.value);
    } else {
      errors.push(r.reason?.message || '未知錯誤');
    }
  }
  return { parsedList, errors };
}
