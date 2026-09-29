import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64, SafeAreaTopScrim } from "@hatch/space-sdk/client";
import QRCode from "qrcode";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { api, type ApiResponse } from "./api";

type Folder = ApiResponse<typeof api, "listFolders">["folders"][number];
type Photo = ApiResponse<typeof api, "listPhotos">["photos"][number];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const PAIRING_PREFIX = "watermark-photo-login:";

function pairingToken(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith(PAIRING_PREFIX) ? trimmed.slice(PAIRING_PREFIX.length) : "";
}

function formatWatermarkDate(date: Date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

async function stampPhoto(file: File, folderName: string, note: string, takenAt: Date): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    const maxSide = 2400;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法处理这张照片");
    ctx.drawImage(image, 0, 0, width, height);
    const padding = Math.max(22, Math.round(width * 0.025));
    const mainSize = Math.max(24, Math.round(width * 0.032));
    const subSize = Math.max(18, Math.round(width * 0.021));
    const barHeight = note.trim() ? mainSize + subSize + padding * 2.3 : mainSize + padding * 2;
    const y = height - barHeight;
    ctx.fillStyle = "rgba(15, 18, 18, 0.72)";
    ctx.fillRect(0, y, width, barHeight);
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `600 ${mainSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    ctx.fillText(formatWatermarkDate(takenAt), padding, y + padding + mainSize * 0.82);
    ctx.font = `500 ${subSize}px system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    const detail = note.trim() ? `${folderName} · ${note.trim()}` : folderName;
    ctx.fillText(detail.slice(0, 80), padding, height - padding * 0.7);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("照片生成失败");
    return blob;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export function App() {
  const queryClient = useQueryClient();
  const cameraInput = useRef<HTMLInputElement>(null);
  const albumInput = useRef<HTMLInputElement>(null);
  const scannerImageInput = useRef<HTMLInputElement>(null);
  const scannerVideo = useRef<HTMLVideoElement>(null);
  const scannerControls = useRef<IScannerControls | null>(null);
  const scannerHandled = useRef(false);
  const qrCanvas = useRef<HTMLCanvasElement>(null);
  const [activeFolderId, setActiveFolderId] = useState<number | undefined>();
  const [newFolderName, setNewFolderName] = useState("");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Photo | null>(null);
  const [menuFolder, setMenuFolder] = useState<Folder | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [notice, setNotice] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginMode, setLoginMode] = useState<"code" | "scan">("code");
  const [pairing, setPairing] = useState<{ token: string; expires_at: string } | null>(null);
  const [scannerStatus, setScannerStatus] = useState("");

  const sessionQuery = useQuery({ queryKey: ["session"], queryFn: () => api.getSession({}) });
  const foldersQuery = useQuery({
    queryKey: ["folders"],
    queryFn: () => api.listFolders({}),
    enabled: sessionQuery.data?.authenticated === true,
  });
  const folders = foldersQuery.data?.folders ?? [];
  const selectedFolder = folders.find((folder) => folder.id === activeFolderId);

  const photosQuery = useQuery({
    queryKey: ["photos", activeFolderId, search],
    queryFn: () => api.listPhotos({ folderId: activeFolderId, search }),
    enabled: sessionQuery.data?.authenticated === true,
  });
  const photos = photosQuery.data?.photos ?? [];

  const totalPhotos = useMemo(() => folders.reduce((sum, folder) => sum + folder.photo_count, 0), [folders]);

  const createPairing = useMutation({
    mutationFn: () => api.createPairing({}),
    onSuccess: (result) => {
      setPairing(result);
      setScannerStatus("");
    },
  });

  const claimPairing = useMutation({
    mutationFn: (token: string) => api.claimPairing({ token }),
    onSuccess: async () => {
      scannerControls.current?.stop();
      scannerControls.current = null;
      setLoginOpen(false);
      setPairing(null);
      setNotice("扫码登录成功，已切换到该影像档案");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["session"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
      ]);
    },
    onError: (reason) => {
      scannerHandled.current = false;
      setScannerStatus(reason instanceof Error ? reason.message : "登录失败，请重新扫描");
    },
  });

  const disconnectPairing = useMutation({
    mutationFn: () => api.disconnectPairing({}),
    onSuccess: async () => {
      setLoginOpen(false);
      setActiveFolderId(undefined);
      setNotice("已退出扫码登录，切回当前账户");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["session"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
      ]);
    },
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => api.createFolder({ name }),
    onSuccess: async (created) => {
      setNewFolderName("");
      setActiveFolderId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["folders"] });
      setNotice("文件夹已创建");
    },
  });

  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedFolder) throw new Error("请先选择一个文件夹");
      const takenAt = new Date();
      const stamped = await stampPhoto(file, selectedFolder.name, note, takenAt);
      const encoded = await fileToBase64(stamped);
      return api.uploadPhoto({
        folderId: selectedFolder.id,
        dataBase64: encoded.dataBase64,
        mimeType: "image/jpeg",
        filename: `IMG_${formatWatermarkDate(takenAt).replace(/[-: ]/g, "")}.jpg`,
        note,
        capturedAt: takenAt.toISOString(),
      });
    },
    onSuccess: async () => {
      setNote("");
      setNotice("照片已加水印并归档");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
      ]);
    },
  });

  const deletePhoto = useMutation({
    mutationFn: (id: number) => api.deletePhoto({ id }),
    onSuccess: async () => {
      setPreview(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
      ]);
    },
  });

  const renameFolder = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.renameFolder({ id, name }),
    onSuccess: async () => {
      setMenuFolder(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
      ]);
    },
  });

  const deleteFolder = useMutation({
    mutationFn: (id: number) => api.deleteFolder({ id }),
    onSuccess: async (_, id) => {
      if (activeFolderId === id) setActiveFolderId(undefined);
      setMenuFolder(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
      ]);
    },
  });

  useEffect(() => {
    if (!pairing || !qrCanvas.current) return;
    void QRCode.toCanvas(qrCanvas.current, `${PAIRING_PREFIX}${pairing.token}`, {
      width: 248,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#171a1b", light: "#ffffff" },
    });
  }, [pairing]);

  useEffect(() => {
    if (!loginOpen || loginMode !== "scan" || !scannerVideo.current) return;
    let cancelled = false;
    scannerHandled.current = false;
    setScannerStatus("正在启动相机…");
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250 });
    void reader.decodeFromVideoDevice(undefined, scannerVideo.current, (result) => {
      if (!result || scannerHandled.current || cancelled) return;
      const token = pairingToken(result.getText());
      if (!token) {
        setScannerStatus("这不是本应用的登录码，请对准正确二维码");
        return;
      }
      scannerHandled.current = true;
      scannerControls.current?.stop();
      setScannerStatus("已识别，正在登录…");
      claimPairing.mutate(token);
    }).then((controls) => {
      if (cancelled) controls.stop();
      else {
        scannerControls.current = controls;
        setScannerStatus("将二维码完整放入取景框");
      }
    }).catch(() => {
      if (!cancelled) setScannerStatus("无法打开相机，可改为上传二维码图片");
    });
    return () => {
      cancelled = true;
      scannerControls.current?.stop();
      scannerControls.current = null;
    };
  }, [loginMode, loginOpen]);

  async function scanImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      setScannerStatus("正在识别二维码图片…");
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      const token = pairingToken(result.getText());
      if (!token) throw new Error("这不是本应用的登录码");
      scannerHandled.current = true;
      claimPairing.mutate(token);
    } catch (reason) {
      scannerHandled.current = false;
      setScannerStatus(reason instanceof Error ? reason.message : "没有识别到二维码");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function openLogin(mode: "code" | "scan") {
    setLoginMode(mode);
    setLoginOpen(true);
    setScannerStatus("");
    if (mode === "code" && !pairing) createPairing.mutate();
  }

  function closeLogin() {
    scannerControls.current?.stop();
    scannerControls.current = null;
    setLoginOpen(false);
  }

  function submitFolder(event: FormEvent) {
    event.preventDefault();
    if (newFolderName.trim()) createFolder.mutate(newFolderName.trim());
  }

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!selectedFolder) {
      setNotice("先选择或新建文件夹，再拍照");
      return;
    }
    uploadPhoto.mutate(file);
  }

  const error = createFolder.error ?? uploadPhoto.error ?? deletePhoto.error ?? renameFolder.error ?? deleteFolder.error ?? disconnectPairing.error;

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="layout">
        {sessionQuery.isPending ? (
          <section className="auth-gate" aria-live="polite">
            <span className="auth-mark" aria-hidden="true" />
            <h1>正在确认登录状态</h1>
            <p>请稍候，正在连接你的影像档案。</p>
          </section>
        ) : sessionQuery.data?.authenticated !== true ? (
          <section className="auth-gate">
            <span className="auth-mark locked" aria-hidden="true" />
            <h1>请先登录 Muse</h1>
            <p>登录后可使用设备二维码，并安全访问水印照片与文件夹。</p>
            <button className="solid-button" onClick={() => void sessionQuery.refetch()}>重新检查</button>
          </section>
        ) : (
          <>
        <section className="capture-panel" aria-labelledby="capture-heading">
          <div className="section-heading">
            <div>
              <p className="date-line">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</p>
              <h1 id="capture-heading">现场影像</h1>
            </div>
            <div className="heading-actions">
              <span className="archive-count">{totalPhotos} 张归档</span>
              <button className={`device-button ${sessionQuery.data?.linked ? "linked" : ""}`} onClick={() => openLogin(sessionQuery.data?.linked ? "scan" : "code")}>
                <span className="device-dot" aria-hidden="true" />
                {sessionQuery.data?.linked ? "已扫码登录" : "设备登录"}
              </button>
            </div>
          </div>

          {folders.length === 0 ? (
            <form className="empty-folder" onSubmit={submitFolder}>
              <div className="folder-mark" aria-hidden="true"><span /></div>
              <h2>先建一个资料文件夹</h2>
              <p>每张照片会自动加上拍摄时间、文件夹名称和你的备注。</p>
              <label htmlFor="new-folder">文件夹名称</label>
              <div className="inline-form">
                <input id="new-folder" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="如：9月安全巡查" maxLength={40} />
                <button type="submit" className="solid-button" disabled={!newFolderName.trim() || createFolder.isPending}>创建</button>
              </div>
            </form>
          ) : (
            <>
              <div className="folder-strip" aria-label="选择文件夹">
                {folders.map((folder) => (
                  <div className={`folder-pill ${folder.id === activeFolderId ? "active" : ""}`} key={folder.id}>
                    <button className="folder-select" onClick={() => setActiveFolderId(folder.id)} aria-pressed={folder.id === activeFolderId}>
                      <span>{folder.name}</span><small>{folder.photo_count}</small>
                    </button>
                    <button className="folder-menu" aria-label={`管理文件夹 ${folder.name}`} onClick={() => { setMenuFolder(folder); setRenameValue(folder.name); }}>•••</button>
                  </div>
                ))}
                <form className="quick-folder" onSubmit={submitFolder}>
                  <input aria-label="新文件夹名称" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="新文件夹" maxLength={40} />
                  <button type="submit" aria-label="创建新文件夹" disabled={!newFolderName.trim() || createFolder.isPending}>＋</button>
                </form>
              </div>

              <div className={`viewfinder ${selectedFolder ? "ready" : ""}`}>
                <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
                <div className="viewfinder-copy">
                  <span className="live-dot" />
                  <p>{selectedFolder ? selectedFolder.name : "选择上方文件夹"}</p>
                  <strong>{selectedFolder ? "时间水印已就绪" : "照片需要归档位置"}</strong>
                </div>
                <label htmlFor="photo-note">水印备注（可选）</label>
                <input id="photo-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：东区三楼消防通道" maxLength={120} disabled={!selectedFolder} />
                <div className="capture-actions">
                  <button className="camera-button" onClick={() => cameraInput.current?.click()} disabled={!selectedFolder || uploadPhoto.isPending}>
                    <span className="camera-lens" aria-hidden="true" />
                    {uploadPhoto.isPending ? "处理中…" : "拍照并加水印"}
                  </button>
                  <button className="album-button" onClick={() => albumInput.current?.click()} disabled={!selectedFolder || uploadPhoto.isPending}>从相册选择</button>
                </div>
                <input ref={cameraInput} className="hidden-input" type="file" accept="image/*" capture="environment" onChange={pickFile} aria-label="调用后置相机拍照" />
                <input ref={albumInput} className="hidden-input" type="file" accept="image/*" onChange={pickFile} aria-label="从相册选择照片" />
              </div>
            </>
          )}

          {(notice || error) && (
            <button className={`toast ${error ? "error" : ""}`} onClick={() => setNotice("")} aria-label="关闭提示">
              {error ? String(error instanceof Error ? error.message : error) : notice}
            </button>
          )}
        </section>

        <section className="archive-panel" aria-labelledby="archive-heading">
          <div className="archive-title-row">
            <div><p>后台归档</p><h2 id="archive-heading">{selectedFolder?.name ?? "全部照片"}</h2></div>
            {totalPhotos > 0 && <span>{photos.length} 项</span>}
          </div>
          {totalPhotos > 0 && (
            <div className="archive-tools">
              <button className={!activeFolderId ? "selected" : ""} onClick={() => setActiveFolderId(undefined)}>全部</button>
              <input aria-label="搜索照片备注" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索备注" />
            </div>
          )}

          {photosQuery.isPending ? (
            <div className="status-copy">正在读取归档…</div>
          ) : photosQuery.error ? (
            <div className="status-copy">归档读取失败，请稍后重试。</div>
          ) : photos.length === 0 ? (
            <div className="empty-archive">
              <div className="stack-lines" aria-hidden="true"><i /><i /><i /></div>
              <h3>{totalPhotos === 0 ? "还没有照片" : "没有匹配的照片"}</h3>
              <p>{totalPhotos === 0 ? "选择文件夹后拍下第一张现场记录。" : "换个文件夹或清除搜索词试试。"}</p>
            </div>
          ) : (
            <div className="photo-grid">
              {photos.map((photo) => (
                <button className="photo-card" key={photo.id} onClick={() => setPreview(photo)} aria-label={`查看照片 ${photo.note || photo.filename}`}>
                  <img src={photo.url} alt={photo.note ? `带水印的现场照片：${photo.note}` : "带时间水印的现场照片"} />
                  <span className="photo-meta"><strong>{formatDate(photo.captured_at)}</strong><small>{photo.folder_name}{photo.note ? ` · ${photo.note}` : ""}</small></span>
                </button>
              ))}
            </div>
          )}
        </section>
          </>
        )}
      </main>

      {loginOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="设备扫码登录">
          <div className="login-modal">
            <button className="modal-close" onClick={closeLogin} aria-label="关闭设备登录">×</button>
            <p className="modal-kicker">设备连接</p>
            <h2>{sessionQuery.data?.linked ? "已通过二维码登录" : "扫码登录影像档案"}</h2>
            <p className="login-explain">在已登录设备上显示二维码，再用手机打开本应用扫描。登录码 5 分钟有效且只能使用一次。</p>

            {sessionQuery.data?.linked ? (
              <div className="linked-panel">
                <span className="linked-check" aria-hidden="true">✓</span>
                <strong>当前设备正在访问已连接的影像档案</strong>
                <p>退出后会切回当前 Muse 账户自己的档案。</p>
                <button className="outline-button wide" onClick={() => disconnectPairing.mutate()} disabled={disconnectPairing.isPending}>
                  {disconnectPairing.isPending ? "正在退出…" : "退出扫码登录"}
                </button>
              </div>
            ) : (
              <>
                <div className="login-tabs" role="tablist" aria-label="设备登录方式">
                  <button role="tab" aria-selected={loginMode === "code"} onClick={() => { setLoginMode("code"); if (!pairing) createPairing.mutate(); }}>显示二维码</button>
                  <button role="tab" aria-selected={loginMode === "scan"} onClick={() => setLoginMode("scan")}>手机扫码</button>
                </div>

                {loginMode === "code" ? (
                  <div className="qr-panel">
                    {createPairing.isPending ? (
                      <div className="qr-placeholder">正在生成一次性登录码…</div>
                    ) : pairing ? (
                      <>
                        <canvas ref={qrCanvas} aria-label="一次性设备登录二维码" />
                        <p>请在另一台手机上打开本应用，选择“手机扫码”。</p>
                        <small>有效期至 {formatDate(pairing.expires_at)}</small>
                        <button className="text-button" onClick={() => createPairing.mutate()} disabled={createPairing.isPending}>刷新登录码</button>
                      </>
                    ) : (
                      <div className="qr-placeholder">
                        <p>{createPairing.error instanceof Error ? createPairing.error.message : "登录码尚未生成"}</p>
                        <button className="solid-button" onClick={() => createPairing.mutate()}>重新生成</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="scanner-panel">
                    <div className="scanner-frame">
                      <video ref={scannerVideo} muted playsInline aria-label="二维码扫描取景器" />
                      <span className="scan-corner s1" /><span className="scan-corner s2" /><span className="scan-corner s3" /><span className="scan-corner s4" />
                    </div>
                    <p className={claimPairing.error ? "scan-error" : ""}>{scannerStatus || "允许相机权限后对准登录二维码"}</p>
                    <button className="outline-button wide" onClick={() => scannerImageInput.current?.click()} disabled={claimPairing.isPending}>从相册选择二维码</button>
                    <input ref={scannerImageInput} className="hidden-input" type="file" accept="image/*" onChange={scanImage} aria-label="从相册选择二维码图片" />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="照片预览">
          <div className="preview-modal">
            <button className="modal-close" onClick={() => setPreview(null)} aria-label="关闭照片预览">×</button>
            <img src={preview.url} alt={preview.note || "带水印的现场照片"} />
            <div className="preview-info"><strong>{preview.folder_name}</strong><span>{formatDate(preview.captured_at)}</span><p>{preview.note || "无备注"}</p></div>
            <a className="download-button" href={preview.url} download={preview.filename}>下载原图</a>
            <button className="danger-link" onClick={() => deletePhoto.mutate(preview.id)} disabled={deletePhoto.isPending}>{deletePhoto.isPending ? "正在删除…" : "删除这张照片"}</button>
          </div>
        </div>
      )}

      {menuFolder && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="管理文件夹">
          <form className="folder-modal" onSubmit={(e) => { e.preventDefault(); if (renameValue.trim()) renameFolder.mutate({ id: menuFolder.id, name: renameValue.trim() }); }}>
            <button type="button" className="modal-close" onClick={() => setMenuFolder(null)} aria-label="关闭文件夹管理">×</button>
            <p>管理文件夹</p><h2>{menuFolder.name}</h2>
            <label htmlFor="rename-folder">文件夹名称</label>
            <input id="rename-folder" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={40} />
            <button className="solid-button wide" type="submit" disabled={!renameValue.trim() || renameFolder.isPending}>保存名称</button>
            <button className="danger-link" type="button" onClick={() => deleteFolder.mutate(menuFolder.id)} disabled={deleteFolder.isPending}>删除文件夹及其中 {menuFolder.photo_count} 张照片</button>
          </form>
        </div>
      )}
    </div>
  );
}
