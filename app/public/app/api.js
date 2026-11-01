async function request(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('vt:signedout'));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}
export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

/** Multipart upload with progress (fetch has no upload progress). */
export function uploadFile(form, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/content/upload');
    x.responseType = 'json';
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => (x.status < 300 ? res(x.response) : rej(new Error(x.response?.error || `Upload failed (${x.status})`)));
    x.onerror = () => rej(new Error('Upload failed: the connection dropped'));
    x.send(form);
  });
}
