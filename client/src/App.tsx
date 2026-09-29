import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64, SafeAreaTopScrim } from "@hatch/space-sdk/client";
import QRCode from "qrcode";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { api, type ApiResponse } from "./api";

type Folder = ApiResponse<typeof api, "listFolders">["folders"][number];
type Photo = ApiResponse<typeof api, "listPhotos">["photos"][number];
type CaptureAssignment = ApiResponse<typeof api, "listCaptureAssignments">["assignments"][number];
type ScannedAssignment = ApiResponse<typeof api, "inspectCaptureAssignment">;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const PAIRING_PREFIX = "watermark-photo-login:";
const CAPTURE_PREFIX = "watermark-photo-task:";

type CaptureCodePayload = {
  v: 1;
  token: string;
  unit: string;
  location: string;
  photographer: string;
};

function pairingToken(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith(PAIRING_PREFIX) ? trimmed.slice(PAIRING_PREFIX.length) : "";
}

function capturePayload(value: string): CaptureCodePayload | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(CAPTURE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(CAPTURE_PREFIX.length));
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<CaptureCodePayload>;
    if (candidate.v !== 1 || typeof candidate.token !== "string" || typeof candidate.unit !== "string" || typeof candidate.location !== "string" || typeof candidate.photographer !== "string") return null;
    return { v: 1, token: candidate.token, unit: candidate.unit, location: candidate.location, photographer: candidate.photographer };
  } catch {
    return null;
  }
}

function assignmentQrValue(assignment: Pick<CaptureAssignment, "token" | "unit_name" | "location_text" | "photographer">) {
  const payload: CaptureCodePayload = {
    v: 1,
    token: assignment.token,
    unit: assignment.unit_name,
    location: assignment.location_text,
    photographer: assignment.photographer,
  };
  return `${CAPTURE_PREFIX}${JSON.stringify(payload)}`;
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

async function stampPhoto(file: File, details: string[], takenAt: Date): Promise<Blob> {
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
    const cleanDetails = details.map((item) => item.trim()).filter(Boolean);
    const lineHeight = subSize * 1.35;
    const barHeight = mainSize + cleanDetails.length * lineHeight + padding * 1.9;
    const y = Math.max(0, height - barHeight);
    ctx.fillStyle = "rgba(15, 18, 18, 0.76)";
    ctx.fillRect(0, y, width, barHeight);
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `600 ${mainSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    ctx.fillText(formatWatermarkDate(takenAt), padding, y + padding + mainSize * 0.82);
    ctx.font = `500 ${subSize}px system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    cleanDetails.forEach((detail, index) => {
      let visible = detail;
      while (visible.length > 1 && ctx.measureText(`${visible}…`).width > width - padding * 2) visible = visible.slice(0, -1);
      ctx.fillText(visible === detail ? visible : `${visible}…`, padding, y + padding + mainSize + lineHeight * (index + 0.82));
    });
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
  const assignmentQrCanvas = useRef<HTMLCanvasElement>(null);
  const assignmentScannerVideo = useRef<HTMLVideoElement>(null);
  const assignmentScannerControls = useRef<IScannerControls | null>(null);
  const assignmentScannerHandled = useRef(false);
  const assignmentImageInput = useRef<HTMLInputElement>(null);
  const assignmentCameraInput = useRef<HTMLInputElement>(null);
  const assignmentAlbumInput = useRef<HTMLInputElement>(null);
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
  const [assignmentManagerOpen, setAssignmentManagerOpen] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState({ folderId: "", unitName: "", locationText: "", photographer: "" });
  const [currentAssignment, setCurrentAssignment] = useState<CaptureAssignment | null>(null);
  const [captureScannerOpen, setCaptureScannerOpen] = useState(false);
  const [captureScannerStatus, setCaptureScannerStatus] = useState("");
  const [scannedAssignment, setScannedAssignment] = useState<ScannedAssignment | null>(null);

  const sessionQuery = useQuery({ queryKey: ["session"], queryFn: () => api.getSession({}) });
  const foldersQuery = useQuery({
    queryKey: ["folders"],
    queryFn: () => api.listFolders({}),
    enabled: sessionQuery.data?.authenticated === true,
  });
  const folders = foldersQuery.data?.folders ?? [];
  const selectedFolder = folders.find((folder) => folder.id === activeFolderId);
  const assignmentsQuery = useQuery({
    queryKey: ["capture-assignments"],
    queryFn: () => api.listCaptureAssignments({}),
    enabled: sessionQuery.data?.authenticated === true,
  });
  const assignments = assignmentsQuery.data?.assignments ?? [];

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

  const createAssignment = useMutation({
    mutationFn: () => api.createCaptureAssignment({
      folderId: Number(assignmentForm.folderId),
      unitName: assignmentForm.unitName,
      locationText: assignmentForm.locationText,
      photographer: assignmentForm.photographer,
    }),
    onSuccess: async (created) => {
      setCurrentAssignment(created);
      await queryClient.invalidateQueries({ queryKey: ["capture-assignments"] });
    },
  });

  const setAssignmentActive = useMutation({
    mutationFn: ({ token, active }: { token: string; active: boolean }) => api.setCaptureAssignmentActive({ token, active }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["capture-assignments"] });
    },
  });

  const inspectAssignment = useMutation({
    mutationFn: (token: string) => api.inspectCaptureAssignment({ token }),
    onSuccess: (assignment) => {
      assignmentScannerControls.current?.stop();
      assignmentScannerControls.current = null;
      setScannedAssignment(assignment);
      setCaptureScannerStatus("");
    },
    onError: (reason) => {
      assignmentScannerHandled.current = false;
      setCaptureScannerStatus(reason instanceof Error ? reason.message : "拍摄码验证失败");
    },
  });

  const uploadAssignmentPhoto = useMutation({
    mutationFn: async (file: File) => {
      if (!scannedAssignment) throw new Error("请先扫描拍摄二维码");
      const takenAt = new Date();
      const stamped = await stampPhoto(file, [
        `单位：${scannedAssignment.unit_name}`,
        `地点：${scannedAssignment.location_text}`,
        `拍摄人员：${scannedAssignment.photographer}`,
      ], takenAt);
      const encoded = await fileToBase64(stamped);
      return api.uploadCaptureAssignmentPhoto({
        token: scannedAssignment.token,
        dataBase64: encoded.dataBase64,
        mimeType: "image/jpeg",
        filename: `QR_${formatWatermarkDate(takenAt).replace(/[-: ]/g, "")}.jpg`,
        capturedAt: takenAt.toISOString(),
      });
    },
    onSuccess: async () => {
      setNotice("扫码照片已上传到管理员文件夹");
      setCaptureScannerOpen(false);
      setScannedAssignment(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
      ]);
    },
  });

  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedFolder) throw new Error("请先选择一个文件夹");
      const takenAt = new Date();
      const stamped = await stampPhoto(file, [selectedFolder.name, note], takenAt);
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
    if (!assignmentManagerOpen || assignmentForm.folderId || folders.length === 0) return;
    const firstFolder = folders[0];
    if (firstFolder) setAssignmentForm((current) => ({ ...current, folderId: String(firstFolder.id) }));
  }, [assignmentManagerOpen, assignmentForm.folderId, folders]);

  useEffect(() => {
    if (!currentAssignment || !assignmentQrCanvas.current) return;
    void QRCode.toCanvas(assignmentQrCanvas.current, assignmentQrValue(currentAssignment), {
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#171a1b", light: "#ffffff" },
    });
  }, [currentAssignment]);

  useEffect(() => {
    if (!captureScannerOpen || scannedAssignment || !assignmentScannerVideo.current) return;
    let cancelled = false;
    assignmentScannerHandled.current = false;
    setCaptureScannerStatus("正在启动相机…");
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250 });
    void reader.decodeFromVideoDevice(undefined, assignmentScannerVideo.current, (result) => {
      if (!result || assignmentScannerHandled.current || cancelled) return;
      const payload = capturePayload(result.getText());
      if (!payload) {
        setCaptureScannerStatus("这不是同事拍摄码，请对准正确二维码");
        return;
      }
      assignmentScannerHandled.current = true;
      assignmentScannerControls.current?.stop();
      setCaptureScannerStatus("已识别，正在验证…");
      inspectAssignment.mutate(payload.token);
    }).then((controls) => {
      if (cancelled) controls.stop();
      else {
        assignmentScannerControls.current = controls;
        setCaptureScannerStatus("将同事拍摄码完整放入取景框");
      }
    }).catch(() => {
      if (!cancelled) setCaptureScannerStatus("无法打开相机，可改为上传二维码图片");
    });
    return () => {
      cancelled = true;
      assignmentScannerControls.current?.stop();
      assignmentScannerControls.current = null;
    };
  }, [captureScannerOpen, scannedAssignment]);

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

  async function scanAssignmentImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      setCaptureScannerStatus("正在识别拍摄码…");
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      const payload = capturePayload(result.getText());
      if (!payload) throw new Error("这不是本应用的同事拍摄码");
      assignmentScannerHandled.current = true;
      inspectAssignment.mutate(payload.token);
    } catch (reason) {
      assignmentScannerHandled.current = false;
      setCaptureScannerStatus(reason instanceof Error ? reason.message : "没有识别到拍摄码");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function pickAssignmentPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) uploadAssignmentPhoto.mutate(file);
  }

  function openCaptureScanner() {
    setScannedAssignment(null);
    setCaptureScannerStatus("");
    setCaptureScannerOpen(true);
  }

  function closeCaptureScanner() {
    assignmentScannerControls.current?.stop();
    assignmentScannerControls.current = null;
    setCaptureScannerOpen(false);
    setScannedAssignment(null);
  }

  function downloadAssignmentQr() {
    if (!assignmentQrCanvas.current || !currentAssignment) return;
    const link = document.createElement("a");
    link.download = `拍摄码-${currentAssignment.photographer}.png`;
    link.href = assignmentQrCanvas.current.toDataURL("image/png");
    link.click();
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

  const error = createFolder.error ?? uploadPhoto.error ?? uploadAssignmentPhoto.error ?? createAssignment.error ?? setAssignmentActive.error ?? deletePhoto.error ?? renameFolder.error ?? deleteFolder.error ?? disconnectPairing.error;

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
              <div className="heading-button-row">
                <button className="scan-task-button" onClick={openCaptureScanner}>扫码拍摄</button>
                <button className="code-manager-button" onClick={() => { setAssignmentManagerOpen(true); setCurrentAssignment(null); }}>同事拍摄码</button>
                <button className={`device-button ${sessionQuery.data?.linked ? "linked" : ""}`} onClick={() => openLogin(sessionQuery.data?.linked ? "scan" : "code")}>
                  <span className="device-dot" aria-hidden="true" />
                  {sessionQuery.data?.linked ? "已扫码登录" : "设备登录"}
                </button>
              </div>
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
                  <span className="photo-meta"><strong>{formatDate(photo.captured_at)}</strong><small>{photo.folder_name}{photo.unit_name ? ` · ${photo.unit_name}` : photo.note ? ` · ${photo.note}` : ""}</small></span>
                </button>
              ))}
            </div>
          )}
        </section>
          </>
        )}
      </main>

      {assignmentManagerOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="同事拍摄码管理">
          <div className="assignment-modal">
            <button className="modal-close" onClick={() => { setAssignmentManagerOpen(false); setCurrentAssignment(null); }} aria-label="关闭同事拍摄码">×</button>
            <p className="modal-kicker">扫码采集</p>
            <h2>同事拍摄码</h2>
            {currentAssignment ? (
              <div className="assignment-qr-view">
                <canvas ref={assignmentQrCanvas} aria-label={`包含${currentAssignment.unit_name}、${currentAssignment.location_text}和${currentAssignment.photographer}的拍摄二维码`} />
                <dl className="assignment-details">
                  <div><dt>单位名称</dt><dd>{currentAssignment.unit_name}</dd></div>
                  <div><dt>地点位置</dt><dd>{currentAssignment.location_text}</dd></div>
                  <div><dt>拍摄人员</dt><dd>{currentAssignment.photographer}</dd></div>
                  <div><dt>归档文件夹</dt><dd>{currentAssignment.folder_name}</dd></div>
                </dl>
                <button className="solid-button wide" onClick={downloadAssignmentQr}>保存二维码图片</button>
                <p className="assignment-help">把图片发给同事。同事登录 Muse 并打开本应用，点击“扫码拍摄”即可上传，照片会直接进入上述文件夹。</p>
                <button className="text-button" onClick={() => setCurrentAssignment(null)}>返回拍摄码列表</button>
              </div>
            ) : (
              <>
                <form className="assignment-form" onSubmit={(event) => { event.preventDefault(); if (assignmentForm.folderId && assignmentForm.unitName.trim() && assignmentForm.locationText.trim() && assignmentForm.photographer.trim()) createAssignment.mutate(); }}>
                  <label htmlFor="assignment-folder">归档文件夹</label>
                  <select id="assignment-folder" value={assignmentForm.folderId} onChange={(event) => setAssignmentForm((current) => ({ ...current, folderId: event.target.value }))} required>
                    <option value="">选择文件夹</option>
                    {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </select>
                  <label htmlFor="assignment-unit">单位名称</label>
                  <input id="assignment-unit" value={assignmentForm.unitName} onChange={(event) => setAssignmentForm((current) => ({ ...current, unitName: event.target.value }))} maxLength={80} placeholder="如：河南省某某单位" required />
                  <label htmlFor="assignment-location">地点位置</label>
                  <input id="assignment-location" value={assignmentForm.locationText} onChange={(event) => setAssignmentForm((current) => ({ ...current, locationText: event.target.value }))} maxLength={100} placeholder="如：东区三楼设备间" required />
                  <label htmlFor="assignment-photographer">拍摄人员</label>
                  <input id="assignment-photographer" value={assignmentForm.photographer} onChange={(event) => setAssignmentForm((current) => ({ ...current, photographer: event.target.value }))} maxLength={40} placeholder="姓名或工号" required />
                  <button className="solid-button wide" type="submit" disabled={!assignmentForm.folderId || !assignmentForm.unitName.trim() || !assignmentForm.locationText.trim() || !assignmentForm.photographer.trim() || createAssignment.isPending}>
                    {createAssignment.isPending ? "正在生成…" : "生成二维码图片"}
                  </button>
                </form>
                <div className="assignment-list">
                  <div className="assignment-list-heading"><strong>已生成</strong><span>{assignments.length} 个</span></div>
                  {assignments.length === 0 ? (
                    <p className="assignment-empty">还没有拍摄码，填写上方信息生成第一个。</p>
                  ) : assignments.map((assignment) => (
                    <div className="assignment-row" key={assignment.token}>
                      <button className="assignment-open" onClick={() => setCurrentAssignment(assignment)}>
                        <strong>{assignment.photographer}</strong>
                        <span>{assignment.unit_name} · {assignment.location_text}</span>
                        <small>{assignment.folder_name} · {assignment.active ? "可使用" : "已停用"}</small>
                      </button>
                      <button className="assignment-toggle" onClick={() => setAssignmentActive.mutate({ token: assignment.token, active: !assignment.active })} disabled={setAssignmentActive.isPending}>
                        {assignment.active ? "停用" : "启用"}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {captureScannerOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="扫描同事拍摄码">
          <div className="capture-code-modal">
            <button className="modal-close" onClick={closeCaptureScanner} aria-label="关闭扫码拍摄">×</button>
            <p className="modal-kicker">同事拍摄</p>
            <h2>{scannedAssignment ? "拍摄信息已载入" : "扫描拍摄码"}</h2>
            {scannedAssignment ? (
              <div className="capture-ready">
                <dl className="assignment-details">
                  <div><dt>单位名称</dt><dd>{scannedAssignment.unit_name}</dd></div>
                  <div><dt>地点位置</dt><dd>{scannedAssignment.location_text}</dd></div>
                  <div><dt>拍摄人员</dt><dd>{scannedAssignment.photographer}</dd></div>
                </dl>
                <p>照片将自动写入拍摄时间和以上信息，并直接归档到管理员指定的文件夹。</p>
                <button className="camera-button wide" onClick={() => assignmentCameraInput.current?.click()} disabled={uploadAssignmentPhoto.isPending}>
                  {uploadAssignmentPhoto.isPending ? "正在上传…" : "拍照并上传"}
                </button>
                <button className="outline-button wide" onClick={() => assignmentAlbumInput.current?.click()} disabled={uploadAssignmentPhoto.isPending}>从相册选择</button>
                <input ref={assignmentCameraInput} className="hidden-input" type="file" accept="image/*" capture="environment" onChange={pickAssignmentPhoto} aria-label="为扫码任务调用后置相机拍照" />
                <input ref={assignmentAlbumInput} className="hidden-input" type="file" accept="image/*" onChange={pickAssignmentPhoto} aria-label="为扫码任务从相册选择照片" />
                {uploadAssignmentPhoto.error && <p className="inline-error">{uploadAssignmentPhoto.error instanceof Error ? uploadAssignmentPhoto.error.message : "上传失败，请重试"}</p>}
              </div>
            ) : (
              <div className="scanner-panel">
                <div className="scanner-frame">
                  <video ref={assignmentScannerVideo} muted playsInline aria-label="同事拍摄码扫描取景器" />
                  <span className="scan-corner s1" /><span className="scan-corner s2" /><span className="scan-corner s3" /><span className="scan-corner s4" />
                </div>
                <p className={inspectAssignment.error ? "scan-error" : ""}>{captureScannerStatus || "允许相机权限后对准同事拍摄码"}</p>
                <button className="outline-button wide" onClick={() => assignmentImageInput.current?.click()} disabled={inspectAssignment.isPending}>从相册选择二维码</button>
                <input ref={assignmentImageInput} className="hidden-input" type="file" accept="image/*" onChange={scanAssignmentImage} aria-label="从相册选择同事拍摄二维码图片" />
              </div>
            )}
          </div>
        </div>
      )}

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
            <div className="preview-info">
              <strong>{preview.folder_name}</strong><span>{formatDate(preview.captured_at)}</span>
              {preview.unit_name ? (
                <dl className="preview-capture-details">
                  <div><dt>单位</dt><dd>{preview.unit_name}</dd></div>
                  <div><dt>地点</dt><dd>{preview.location_text}</dd></div>
                  <div><dt>拍摄人员</dt><dd>{preview.photographer}</dd></div>
                </dl>
              ) : <p>{preview.note || "无备注"}</p>}
            </div>
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
