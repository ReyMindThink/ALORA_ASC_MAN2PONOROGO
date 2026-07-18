import { useState, useEffect, useRef } from "react";
import {
  TreePine,
  Radio,
  Volume2,
  ShieldCheck,
  AlertTriangle,
  Sliders,
  MapPin,
  ExternalLink,
  History,
  Wifi,
  WifiOff,
  SlidersHorizontal,
  RefreshCw,
  Copy,
  Check,
  Server,
  Sparkles,
  Info,
  Layers,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Types matching Arduino structures
interface NodeSensor {
  name?: string;
  lat?: number;
  lng?: number;
  last_seen?: number;
  detected?: boolean; // status LIVE dari paket LoRa terakhir node ini (bukan riwayat alert)
}

interface PermitWindow {
  start_ts: number;
  end_ts: number;
  note?: string;
}

// Satu entri riwayat izin tebang yang PERNAH dibuat (bukan cuma yang sedang
// aktif) -- disimpan terpisah dari /permit.json (yang cuma menyimpan 1 jadwal
// aktif) supaya bisa dihitung berapa kali izin tebang pernah diterbitkan.
interface PermitHistoryEntry {
  id: string;
  start_ts: number;
  end_ts: number;
  note?: string;
  created_at: number;
}

interface AlertItem {
  id: string;
  node_id: string;
  timestamp: number;
  confidence: number;
  acknowledged: boolean;
}

interface FirebaseStatus {
  last_seen: number;
}

export default function App() {
  // Configs
  const FIREBASE_HOST =
    "lora-c0e72-default-rtdb.asia-southeast1.firebasedatabase.app";
  const FIREBASE_URL =
    "https://lora-c0e72-default-rtdb.asia-southeast1.firebasedatabase.app";

  // State
  // PERBAIKAN: sebelumnya di sini ada data bohongan (node-1/node-2 dengan
  // koordinat karangan + 2 alert palsu "12 menit lalu"/"45 menit lalu") yang
  // langsung tampil begitu web dibuka, SEBELUM sempat fetch ke Firebase.
  // Ini yang bikin dashboard terkesan "mengada-ada" -- padahal cuma ada 1 node
  // sungguhan. Sekarang mulai kosong; apa pun yang tampil murni hasil fetch
  // dari Firebase (data node sungguhan akan otomatis muncul begitu gateway
  // pernah meneruskan minimal 1 paket dari node tersebut).
  const [nodes, setNodes] = useState<Record<string, NodeSensor>>({});
  const [alerts, setAlerts] = useState<Record<string, AlertItem>>({});
  const [status, setStatus] = useState<FirebaseStatus>({ last_seen: 0 });
  const [sensitivity, setSensitivity] = useState<number>(75);

  // Ambang waktu untuk anggap sebuah node "mati/tidak terdeteksi": kalau last_seen
  // sudah lebih lama dari ini, node dianggap offline (bukan cuma "aman").
  const NODE_OFFLINE_THRESHOLD_MS = 3 * 60 * 1000; // 3 menit

  // Izin tebang (permit) - jendela waktu resmi yang membuat deteksi gergaji tidak dianggap ancaman
  const [permit, setPermit] = useState<PermitWindow | null>(null);
  const [permitStartInput, setPermitStartInput] = useState<string>("");
  const [permitEndInput, setPermitEndInput] = useState<string>("");
  const [permitNoteInput, setPermitNoteInput] = useState<string>("");
  const [isSavingPermit, setIsSavingPermit] = useState<boolean>(false);

  // Riwayat izin tebang (semua izin yang PERNAH dibuat, bukan cuma yang aktif)
  const [permitHistory, setPermitHistory] = useState<
    Record<string, PermitHistoryEntry>
  >({});

  // Edit nama kustom node (ID hardware tetap, cuma label tampilan yang bisa diganti)
  const [editingNameNodeId, setEditingNameNodeId] = useState<string | null>(
    null,
  );
  const [editNameValue, setEditNameValue] = useState<string>("");
  const [isSavingName, setIsSavingName] = useState<boolean>(false);

  // Manajemen node manual (tambah / edit koordinat / hapus)
  const [newNodeId, setNewNodeId] = useState<string>("");
  const [newNodeLat, setNewNodeLat] = useState<string>("");
  const [newNodeLng, setNewNodeLng] = useState<string>("");
  const [isSavingNode, setIsSavingNode] = useState<boolean>(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editLat, setEditLat] = useState<string>("");
  const [editLng, setEditLng] = useState<string>("");

  const [isConnected, setIsConnected] = useState<boolean>(true);
  const [isUsingMock, setIsUsingMock] = useState<boolean>(false);
  const [lastSynced, setLastSynced] = useState<Date>(new Date());
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [copiedHtml, setCopiedHtml] = useState<boolean>(false);
  const [showSandbox, setShowSandbox] = useState<boolean>(true);
  const [showHtmlExport, setShowHtmlExport] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Berapa kali fetch gagal berturut-turut sebelum dashboard benar-benar dianggap
  // "putus" dan pindah ke Modus Simulasi. Ini mencegah satu kegagalan sesaat (jitter
  // jaringan, request lambat, dsb.) langsung membuat dashboard terlihat "palsu".
  const consecutiveFailuresRef = useRef(0);
  const MAX_CONSECUTIVE_FAILURES = 3;

  // Poll intervals
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  // Firmware ESP32 (time()/NTP) umumnya mengirim unix timestamp dalam
  // DETIK, sedangkan Date.now() & new Date() di JS bekerja dalam MILIDETIK.
  // Kalau nilai detik itu langsung dipakai sebagai ms tanpa dikonversi,
  // selisihnya jadi ~1000x lipat -- ini penyebab tulisan aneh semacam
  // "20629 hari lalu" padahal datanya baru saja masuk. Normalisasi dilakukan
  // sekali di sini, tepat saat data masuk dari Firebase, supaya seluruh
  // state (nodes, alerts, status) sudah konsisten dalam ms.
  const toMs = (ts?: number | null): number => {
    if (!ts) return 0;
    // Timestamp era sekarang dalam ms selalu > 1e12 (~ tahun 2001+).
    // Kalau nilainya lebih kecil dari itu, hampir pasti itu detik -> x1000.
    return ts < 1e12 ? ts * 1000 : ts;
  };

  const fetchData = async () => {
    setIsSyncing(true);
    try {
      // 1. Fetch status
      const statusRes = await fetch(`${FIREBASE_URL}/status.json`);
      if (!statusRes.ok) throw new Error(`HTTP status: ${statusRes.status}`);
      const statusData = await statusRes.json();
      if (statusData) {
        setStatus({
          ...statusData,
          last_seen: toMs(statusData.last_seen),
        });
      }

      // 2. Fetch nodes
      const nodesRes = await fetch(`${FIREBASE_URL}/nodes.json`);
      if (!nodesRes.ok) throw new Error(`HTTP nodes: ${nodesRes.status}`);
      const nodesData = await nodesRes.json();
      if (nodesData) {
        const normalizedNodes: Record<string, NodeSensor> = {};
        Object.entries(nodesData).forEach(([key, val]: [string, any]) => {
          normalizedNodes[key] = {
            ...val,
            last_seen: toMs(val?.last_seen),
          };
        });
        setNodes(normalizedNodes);
      }

      // 3. Fetch alerts
      const alertsRes = await fetch(`${FIREBASE_URL}/alerts.json`);
      if (!alertsRes.ok) throw new Error(`HTTP alerts: ${alertsRes.status}`);
      const alertsData = await alertsRes.json();
      if (alertsData) {
        // Firebase objects may have keys. Normalize into record with id inside
        const normalized: Record<string, AlertItem> = {};
        Object.entries(alertsData).forEach(([key, val]: [string, any]) => {
          normalized[key] = {
            id: key,
            node_id: val.node_id || "node-unknown",
            timestamp: val.timestamp ? toMs(val.timestamp) : Date.now(),
            confidence: val.confidence || 90,
            acknowledged:
              typeof val.acknowledged === "boolean" ? val.acknowledged : false,
          };
        });
        setAlerts(normalized);
      } else {
        setAlerts({});
      }

      // 4. Fetch sensitivity
      const sensRes = await fetch(`${FIREBASE_URL}/control/sensitivity.json`);
      if (sensRes.ok) {
        const sensVal = await sensRes.json();
        if (typeof sensVal === "number") {
          setSensitivity(sensVal);
        }
      }

      // 5. Fetch permit (izin tebang) window
      const permitRes = await fetch(`${FIREBASE_URL}/permit.json`);
      if (permitRes.ok) {
        const permitData = await permitRes.json();
        if (
          permitData &&
          typeof permitData.start_ts === "number" &&
          typeof permitData.end_ts === "number"
        ) {
          setPermit(permitData);
        } else {
          setPermit(null);
        }
      }

      // 6. Fetch riwayat izin tebang (semua izin yang pernah dibuat, untuk histori)
      const permitHistoryRes = await fetch(
        `${FIREBASE_URL}/permit_history.json`,
      );
      if (permitHistoryRes.ok) {
        const permitHistoryData = await permitHistoryRes.json();
        if (permitHistoryData) {
          const normalizedHistory: Record<string, PermitHistoryEntry> = {};
          Object.entries(permitHistoryData).forEach(
            ([key, val]: [string, any]) => {
              normalizedHistory[key] = {
                id: key,
                start_ts: val.start_ts,
                end_ts: val.end_ts,
                note: val.note,
                created_at: val.created_at || val.start_ts,
              };
            },
          );
          setPermitHistory(normalizedHistory);
        } else {
          setPermitHistory({});
        }
      }

      // Fetch berhasil penuh: reset penghitung kegagalan dan kembalikan dashboard
      // ke mode data asli (kalau sebelumnya sempat jatuh ke simulasi).
      consecutiveFailuresRef.current = 0;
      setIsConnected(true);
      setIsUsingMock(false);
      setSyncError(null);
      setLastSynced(new Date());
    } catch (err: any) {
      consecutiveFailuresRef.current += 1;

      // Bedakan penyebabnya biar gampang didiagnosis: TypeError dari fetch()
      // hampir selalu berarti CORS diblokir atau memang tidak ada koneksi ke
      // internet, sedangkan error lain (yang kita lempar sendiri di atas)
      // biasanya HTTP non-200, contoh paling umum: Firebase Rules belum
      // mengizinkan "read" publik.
      const isLikelyCorsOrOffline = err instanceof TypeError;
      const diagnosis = isLikelyCorsOrOffline
        ? "Tidak bisa terhubung ke Firebase (kemungkinan CORS diblokir atau tidak ada koneksi internet)."
        : `Firebase menolak permintaan: ${err?.message || "error tidak diketahui"}. Cek Firebase Realtime Database > Rules, pastikan "read" diizinkan.`;

      console.warn("Firebase fetch error:", err);
      setSyncError(diagnosis);

      // VERSI MURNI: tidak pernah beralih ke data tiruan/simulasi. Kalau gagal
      // konek berkali-kali, dashboard cuma menampilkan status "Tidak
      // Terhubung" apa adanya -- tidak ada fallback data palsu sama sekali.
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setIsConnected(false);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  // Update sensitivity in Firebase
  const updateSensitivity = async (value: number) => {
    setSensitivity(value);

    // Always update local state first
    if (isUsingMock) return;

    try {
      setIsSyncing(true);
      const res = await fetch(`${FIREBASE_URL}/control/sensitivity.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!res.ok) throw new Error("Gagal menyimpan sensitivitas");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase update sensitivity error:", err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Acknowledge single alert
  const acknowledgeAlert = async (alertId: string) => {
    // 1. Update locally
    setAlerts((prev) => {
      const updated = { ...prev };
      if (updated[alertId]) {
        updated[alertId] = { ...updated[alertId], acknowledged: true };
      }
      return updated;
    });

    if (isUsingMock) return;

    try {
      setIsSyncing(true);
      const res = await fetch(
        `${FIREBASE_URL}/alerts/${alertId}/acknowledged.json`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(true),
        },
      );
      if (!res.ok) throw new Error("Gagal konfirmasi peringatan");
      fetchData(); // reload
    } catch (err) {
      console.error("Firebase ack error:", err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Simpan jendela izin tebang (tanggal & jam mulai-selesai) ke Firebase
  const savePermit = async () => {
    if (!permitStartInput || !permitEndInput) return;
    const startTs = new Date(permitStartInput).getTime();
    const endTs = new Date(permitEndInput).getTime();
    if (isNaN(startTs) || isNaN(endTs) || endTs <= startTs) {
      alert("Jam/tanggal selesai harus setelah jam/tanggal mulai.");
      return;
    }

    const newPermit: PermitWindow = {
      start_ts: startTs,
      end_ts: endTs,
      note: permitNoteInput || undefined,
    };
    setPermit(newPermit);

    if (isUsingMock) return;

    try {
      setIsSavingPermit(true);
      const res = await fetch(`${FIREBASE_URL}/permit.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newPermit),
      });
      if (!res.ok) throw new Error("Gagal menyimpan izin tebang");

      // Catat juga ke /permit_history.json (push -> id unik otomatis) supaya
      // izin ini tetap tercatat di riwayat walau nanti jadwal aktifnya
      // ditimpa jadwal baru atau dihapus lewat "Hapus Izin".
      const historyRes = await fetch(`${FIREBASE_URL}/permit_history.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newPermit, created_at: Date.now() }),
      });
      if (historyRes.ok) {
        const { name: pushedKey } = await historyRes.json();
        setPermitHistory((prev) => ({
          ...prev,
          [pushedKey]: {
            id: pushedKey,
            ...newPermit,
            created_at: Date.now(),
          },
        }));
      }

      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase save permit error:", err);
    } finally {
      setIsSavingPermit(false);
    }
  };

  // Hapus satu entri riwayat izin tebang tertentu
  const deletePermitHistoryEntry = async (entryId: string) => {
    setPermitHistory((prev) => {
      const updated = { ...prev };
      delete updated[entryId];
      return updated;
    });

    if (isUsingMock) return;

    try {
      const res = await fetch(
        `${FIREBASE_URL}/permit_history/${entryId}.json`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Gagal menghapus riwayat izin");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase delete permit history error:", err);
    }
  };

  // Hapus SELURUH riwayat izin tebang
  const clearAllPermitHistory = async () => {
    if (!confirm("Hapus seluruh riwayat izin tebang? Tindakan ini permanen."))
      return;
    setPermitHistory({});

    if (isUsingMock) return;

    try {
      const res = await fetch(`${FIREBASE_URL}/permit_history.json`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Gagal menghapus riwayat izin");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase clear permit history error:", err);
    }
  };

  // Hapus izin tebang yang sedang aktif/tersimpan
  const clearPermit = async () => {
    setPermit(null);
    setPermitStartInput("");
    setPermitEndInput("");
    setPermitNoteInput("");

    if (isUsingMock) return;

    try {
      setIsSavingPermit(true);
      const res = await fetch(`${FIREBASE_URL}/permit.json`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Gagal menghapus izin tebang");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase clear permit error:", err);
    } finally {
      setIsSavingPermit(false);
    }
  };

  // Daftarkan/lengkapi node yang SUDAH otomatis muncul di Firebase (karena
  // gateway pernah meneruskan minimal 1 paket dari node itu) tapi BELUM
  // punya nama & koordinat -- ini alur pendaftaran yang benar: node aktif
  // dulu (terdeteksi gateway), baru admin isi nama kustom + lokasi GPS
  // sebenarnya di lapangan lewat web. Setelah diisi di sini, gateway tidak
  // akan pernah menimpa nilai ini lagi (lihat catatan PATCH di firmware).
  const [regNameInput, setRegNameInput] = useState<Record<string, string>>({});
  const [regLatInput, setRegLatInput] = useState<Record<string, string>>({});
  const [regLngInput, setRegLngInput] = useState<Record<string, string>>({});
  const [isRegistering, setIsRegistering] = useState<string | null>(null);

  const registerNode = async (nodeId: string) => {
    const name = (regNameInput[nodeId] || "").trim();
    const lat = Number(regLatInput[nodeId]);
    const lng = Number(regLngInput[nodeId]);
    if (!name || isNaN(lat) || isNaN(lng)) {
      alert("Isi nama dan koordinat (harus berupa angka) terlebih dahulu.");
      return;
    }

    setNodes((prev) => ({
      ...prev,
      [nodeId]: { ...prev[nodeId], name, lat, lng },
    }));

    if (isUsingMock) return;

    try {
      setIsRegistering(nodeId);
      const res = await fetch(`${FIREBASE_URL}/nodes/${nodeId}.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, lat, lng }),
      });
      if (!res.ok) throw new Error("Gagal mendaftarkan node");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase register node error:", err);
    } finally {
      setIsRegistering(null);
    }
  };

  // Tambah node baru secara manual (mis. sebelum alat fisik dipasang di lapangan)
  const addNode = async () => {
    if (!newNodeId.trim() || !newNodeLat || !newNodeLng) return;
    const lat = Number(newNodeLat);
    const lng = Number(newNodeLng);
    if (isNaN(lat) || isNaN(lng)) {
      alert("Koordinat harus berupa angka.");
      return;
    }

    const nodeId = newNodeId.trim();
    const newNode: NodeSensor = { name: nodeId, lat, lng };
    setNodes((prev) => ({ ...prev, [nodeId]: newNode }));
    setNewNodeId("");
    setNewNodeLat("");
    setNewNodeLng("");

    if (isUsingMock) return;

    try {
      setIsSavingNode(true);
      const res = await fetch(`${FIREBASE_URL}/nodes/${nodeId}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newNode),
      });
      if (!res.ok) throw new Error("Gagal menambah node");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase add node error:", err);
    } finally {
      setIsSavingNode(false);
    }
  };

  // Ubah koordinat node secara manual
  const saveNodeCoords = async (nodeId: string) => {
    const lat = Number(editLat);
    const lng = Number(editLng);
    if (isNaN(lat) || isNaN(lng)) {
      alert("Koordinat harus berupa angka.");
      return;
    }

    setNodes((prev) => ({
      ...prev,
      [nodeId]: { ...prev[nodeId], lat, lng },
    }));
    setEditingNodeId(null);

    if (isUsingMock) return;

    try {
      setIsSavingNode(true);
      await fetch(`${FIREBASE_URL}/nodes/${nodeId}/lat.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lat),
      });
      await fetch(`${FIREBASE_URL}/nodes/${nodeId}/lng.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lng),
      });
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase update node coords error:", err);
    } finally {
      setIsSavingNode(false);
    }
  };

  // Simpan nama kustom (label tampilan) untuk sebuah node. ID node itu sendiri
  // (kunci "nodeId" di Firebase, mis. "node-1") berasal dari #define NODE_ID
  // di firmware ESP32 dan TIDAK BISA diganti dari sini -- yang bisa diubah
  // cuma field "name"-nya. Karena gateway sekarang mem-PATCH (bukan PUT)
  // path /nodes/{id}, nama yang disimpan di sini tidak akan tertimpa balik
  // oleh paket telemetry berikutnya dari node sensor.
  const saveNodeName = async (nodeId: string) => {
    const trimmed = editNameValue.trim();
    if (!trimmed) return;

    setNodes((prev) => ({
      ...prev,
      [nodeId]: { ...prev[nodeId], name: trimmed },
    }));
    setEditingNameNodeId(null);

    if (isUsingMock) return;

    try {
      setIsSavingName(true);
      const res = await fetch(`${FIREBASE_URL}/nodes/${nodeId}/name.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed),
      });
      if (!res.ok) throw new Error("Gagal menyimpan nama node");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase save node name error:", err);
    } finally {
      setIsSavingName(false);
    }
  };

  // Hapus node dari daftar (mis. duplikat atau node yang sudah tidak dipakai)
  const deleteNode = async (nodeId: string) => {
    setNodes((prev) => {
      const updated = { ...prev };
      delete updated[nodeId];
      return updated;
    });

    if (isUsingMock) return;

    try {
      setIsSavingNode(true);
      const res = await fetch(`${FIREBASE_URL}/nodes/${nodeId}.json`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Gagal menghapus node");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase delete node error:", err);
    } finally {
      setIsSavingNode(false);
    }
  };

  // VERSI MURNI: fungsi picu alarm palsu (triggerMockAlert) sengaja DIHAPUS.
  // Semua entri di /alerts.json pada versi ini hanya bisa berasal dari
  // gateway asli meneruskan deteksi node sensor asli -- tidak ada jalur di
  // web ini yang bisa menulis alert karangan.

  // Clear or acknowledge all alerts in simulator
  // PERBAIKAN: sebelumnya cuma ada "Acknowledge Semua Alarm" yang meng-ack
  // SELURUH alert dari SEMUA node sekaligus -- kalau ada 2 node aktif dan yang
  // baru diatasi cuma satu, tombol ini keliru ikut menandai node lain sebagai
  // sudah ditinjau juga. Fungsi ini hanya meng-ack log milik SATU node_id.
  const acknowledgeNodeAlerts = async (nodeId: string) => {
    const idsToAck = Object.entries(alerts)
      .filter(([, a]: [string, any]) => a.node_id === nodeId && !a.acknowledged)
      .map(([key]) => key);
    if (idsToAck.length === 0) return;

    setAlerts((prev) => {
      const updated = { ...prev };
      idsToAck.forEach((key) => {
        updated[key] = { ...updated[key], acknowledged: true };
      });
      return updated;
    });

    if (isUsingMock) return;

    try {
      setIsSyncing(true);
      await Promise.all(
        idsToAck.map((key) =>
          fetch(`${FIREBASE_URL}/alerts/${key}/acknowledged.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(true),
          }),
        ),
      );
      fetchData();
    } catch (err) {
      console.error("Firebase ack per-node error:", err);
    } finally {
      setIsSyncing(false);
    }
  };

  const clearAllAlerts = async () => {
    if (isUsingMock) {
      setAlerts((prev) => {
        const reset: Record<string, AlertItem> = {};
        Object.entries(prev).forEach(([key, val]: [string, any]) => {
          reset[key] = { ...(val as AlertItem), acknowledged: true };
        });
        return reset;
      });
    } else {
      try {
        setIsSyncing(true);
        // We update all unacknowledged alerts to acknowledged = true
        const promises = Object.entries(alerts)
          .filter(([_, alert]: [string, any]) => !alert.acknowledged)
          .map(([key, _]) => {
            return fetch(`${FIREBASE_URL}/alerts/${key}/acknowledged.json`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(true),
            });
          });
        await Promise.all(promises);
        fetchData();
      } catch (err) {
        console.error("Clear alerts simulation error:", err);
      } finally {
        setIsSyncing(false);
      }
    }
  };

  // Hapus SATU log data ancaman/alarm secara permanen dari Firebase (berbeda
  // dari acknowledgeAlert, yang cuma menandai "sudah ditinjau" tapi tetap
  // menyimpan catatannya).
  const deleteAlert = async (alertId: string) => {
    setAlerts((prev) => {
      const updated = { ...prev };
      delete updated[alertId];
      return updated;
    });

    if (isUsingMock) return;

    try {
      setIsSyncing(true);
      const res = await fetch(`${FIREBASE_URL}/alerts/${alertId}.json`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Gagal menghapus data ancaman");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase delete alert error:", err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Hapus SELURUH data ancaman/log alarm secara permanen (beda dari
  // "Tandai Semua Aman" di atas, yang hanya meng-ack tanpa menghapus).
  const deleteAllAlertsData = async () => {
    if (
      !confirm(
        "Hapus SELURUH data ancaman/log alarm secara permanen? Tindakan ini tidak bisa dibatalkan.",
      )
    )
      return;

    setAlerts({});

    if (isUsingMock) return;

    try {
      setIsSyncing(true);
      const res = await fetch(`${FIREBASE_URL}/alerts.json`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Gagal menghapus seluruh data ancaman");
      setLastSynced(new Date());
    } catch (err) {
      console.error("Firebase delete all alerts error:", err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Derived Values
  // Node yang sudah otomatis muncul (gateway pernah meneruskan datanya) tapi
  // belum diisi nama & koordinat oleh admin -- ini yang ditampilkan di panel
  // "Node Terdeteksi, Perlu Didaftarkan".
  const unregisteredNodeEntries = Object.entries(nodes).filter(
    ([, n]: [string, any]) => n.lat == null || n.lng == null,
  );
  // Kebalikannya: node yang sudah lengkap didaftarkan (punya nama & koordinat)
  // -- ini yang ditampilkan di daftar/manajemen/peta, supaya tidak dobel
  // dengan panel "Perlu Didaftarkan" di atas.
  const registeredNodeEntries = Object.entries(nodes).filter(
    ([, n]: [string, any]) => n.lat != null && n.lng != null,
  );

  const alertList = (Object.values(alerts) as AlertItem[]).sort(
    (a, b) => b.timestamp - a.timestamp,
  );
  const unacknowledgedAlerts = alertList.filter(
    (a: AlertItem) => !a.acknowledged,
  );

  // PERBAIKAN PENTING: dulu status "AMAN/TERANCAM" ditentukan dari ada/tidaknya
  // ALERT LAMA yang belum di-"Konfirmasi" -- akibatnya begitu 1 alert (baik
  // asli maupun dari tombol simulasi) pernah tercatat dan tidak ada yang klik
  // Konfirmasi, dashboard akan MENAMPILKAN "TERANCAM" SELAMANYA walau ancaman
  // sudah lama selesai. Sekarang status real-time murni dilihat dari kondisi
  // LIVE tiap node (field `detected` dari paket LoRa TERAKHIR + apakah node itu
  // masih "hidup" dalam NODE_OFFLINE_THRESHOLD_MS terakhir) -- begitu node
  // sensor sendiri melaporkan detected=false (situasi sudah reda), status di
  // web otomatis kembali AMAN tanpa perlu ada yang klik apa pun secara manual.
  // Riwayat alert (unacknowledgedAlerts) tetap ada, tapi sekarang murni jadi
  // LOG/catatan kejadian untuk ditinjau -- tidak lagi mengontrol status utama.
  const liveThreatEntries = Object.entries(nodes).filter(([, n]) => {
    const isFresh =
      !!n.last_seen && Date.now() - n.last_seen < NODE_OFFLINE_THRESHOLD_MS;
    return n.detected === true && isFresh;
  });
  const hasActiveAlert = liveThreatEntries.length > 0;
  const latestActiveNodeId: string | null = liveThreatEntries[0]?.[0] ?? null;

  // Formatting helpers
  const timeAgo = (unixMs: number) => {
    if (!unixMs) return "–";
    const diff = Math.floor((Date.now() - unixMs) / 1000);
    if (diff < 5) return "baru saja";
    if (diff < 60) return `${diff} detik lalu`;
    if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
    return `${Math.floor(diff / 86400)} hari lalu`;
  };

  const formatTimestamp = (unixMs: number) => {
    if (!unixMs) return "–";
    const d = new Date(unixMs);
    return d.toLocaleString("id-ID", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  // Color Palette Definition for response text:
  const colorPalette = [
    {
      name: "Daun Segar (Primary Green)",
      hex: "#22C55E",
      use: "Tombol aktif, status aman, ring nadi utama",
    },
    {
      name: "Kanopi Rimbun (Deep Forest)",
      hex: "#15803D",
      use: "Header, teks utama, logo branding, borders",
    },
    {
      name: "Padang Rumput (Meadow Green)",
      hex: "#F0FDF4",
      use: "Latar belakang kartu statis & panel dashboard",
    },
    {
      name: "Suhu Kayu (Earth Amber)",
      hex: "#854D0E",
      use: "Lencana warning detail & aksen level sensitivitas",
    },
    {
      name: "Sutra Krem (Ivory Cream)",
      hex: "#FAFBF7",
      use: "Latar belakang seluruh halaman (nature-friendly canvas)",
    },
    {
      name: "Siren Merah (Coral Danger)",
      hex: "#EF4444",
      use: "Indikator gergaji mesin terdeteksi & alert bahaya",
    },
  ];

  // Raw HTML code generated for user to export
  const htmlCode = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ALoRa — Dashboard Pemantauan Hutan</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-cream: #fafbf7;
      --bg-card: #ffffff;
      --bg-accent-soft: #f0fdf4;
      --border-natural: #e6ebe1;
      --primary-green: #22c55e;
      --forest-green: #15803d;
      --earth-brown: #854d0e;
      --danger-coral: #ef4444;
      --text-dark: #1e293b;
      --text-muted: #64748b;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-cream);
      color: var(--text-dark);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      padding: 40px 20px;
    }
    
    .container {
      max-width: 1000px;
      margin: 0 auto;
    }
    
    /* Header styling */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
      border-bottom: 1.5px solid var(--border-natural);
      padding-bottom: 24px;
      margin-bottom: 36px;
    }
    
    .brand-eyebrow {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      letter-spacing: 2px;
      color: var(--forest-green);
      text-transform: uppercase;
      font-weight: 600;
      margin-bottom: 6px;
    }
    
    h1 {
      font-family: 'Fraunces', serif;
      font-weight: 600;
      font-size: 32px;
      color: var(--forest-green);
      letter-spacing: -0.02em;
    }
    
    .conn-status {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border-natural);
      padding: 8px 16px;
      border-radius: 20px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      font-weight: 500;
    }
    
    .conn-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--primary-green);
      box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.2);
      animation: pulse 2s infinite;
    }
    
    .conn-dot.offline {
      background: #94a3b8;
      box-shadow: none;
      animation: none;
    }
    
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
      100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
    
    /* Hero Banner */
    .hero {
      display: flex;
      align-items: center;
      gap: 32px;
      background: var(--bg-card);
      border: 1px solid var(--border-natural);
      border-radius: 24px;
      padding: 32px;
      margin-bottom: 32px;
      box-shadow: 0 4px 20px rgba(21, 128, 61, 0.03);
    }
    
    .pulse-circle {
      position: relative;
      width: 80px; height: 80px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: var(--bg-accent-soft);
      border: 2px solid var(--primary-green);
      flex-shrink: 0;
    }
    
    .pulse-circle.alert {
      background: rgba(239, 68, 68, 0.08);
      border-color: var(--danger-coral);
    }
    
    .pulse-icon {
      font-size: 28px;
    }
    
    .hero-info { flex: 1; }
    
    .hero-eyebrow {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-muted);
      letter-spacing: 1.5px;
      margin-bottom: 6px;
    }
    
    .hero-title {
      font-family: 'Fraunces', serif;
      font-size: 28px;
      font-weight: 500;
      color: var(--forest-green);
    }
    
    .hero-title.alert {
      color: var(--danger-coral);
    }
    
    .hero-desc {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    
    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border-natural);
      border-radius: 16px;
      padding: 20px;
    }
    
    .stat-label {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    
    .stat-val {
      font-family: 'Fraunces', serif;
      font-size: 28px;
      font-weight: 500;
      color: var(--forest-green);
    }
    
    .stat-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    
    /* Layout split: main & side */
    .main-layout {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 24px;
    }
    
    @media (max-width: 820px) {
      .main-layout { grid-template-columns: 1fr; }
    }
    
    .card-title {
      font-family: 'Fraunces', serif;
      font-size: 18px;
      font-weight: 600;
      color: var(--forest-green);
      margin-bottom: 20px;
    }
    
    /* Range Slider */
    .slider-box {
      background: var(--bg-card);
      border: 1px solid var(--border-natural);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 24px;
    }
    
    .slider-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    
    .slider-val {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 14px;
      font-weight: bold;
      color: var(--forest-green);
      background: var(--bg-accent-soft);
      padding: 4px 10px;
      border-radius: 8px;
    }
    
    input[type=range] {
      width: 100%;
      accent-color: var(--primary-green);
      height: 6px;
      border-radius: 3px;
      outline: none;
      margin-bottom: 12px;
    }
    
    /* Table / Lists */
    .list-box {
      background: var(--bg-card);
      border: 1px solid var(--border-natural);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 24px;
    }
    
    .node-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 0;
      border-bottom: 1px solid var(--border-natural);
    }
    
    .node-item:last-child { border-bottom: none; }
    
    .node-info { display: flex; align-items: center; gap: 12px; }
    .node-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary-green); }
    .node-dot.alert { background: var(--danger-coral); }
    
    .node-name { font-weight: 600; font-size: 14px; }
    .node-gps { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--text-muted); }
    
    .btn-maps {
      font-size: 12px;
      text-decoration: none;
      color: var(--forest-green);
      border: 1px solid var(--border-natural);
      padding: 6px 12px;
      border-radius: 8px;
      transition: background 0.2s;
    }
    .btn-maps:hover { background: var(--bg-accent-soft); }
    
    /* Timeline Alerts */
    .timeline { border-left: 1.5px solid var(--border-natural); margin-left: 10px; padding-left: 20px; }
    .timeline-item { position: relative; margin-bottom: 24px; }
    .timeline-item::before {
      content: '';
      position: absolute; left: -26px; top: 6px;
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--danger-coral);
      border: 2px solid var(--bg-card);
    }
    .timeline-item.ack::before {
      background: var(--primary-green);
    }
    
    .time-stamp { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--text-muted); }
    .timeline-body { display: flex; justify-content: space-between; align-items: flex-start; margin-top: 4px; }
    .alert-node-title { font-weight: 600; font-size: 14px; }
    .alert-desc { font-size: 12px; color: var(--text-muted); }
    
    .btn-ack {
      font-size: 11px;
      font-family: 'IBM Plex Mono', monospace;
      padding: 4px 8px;
      background: var(--bg-accent-soft);
      border: 1px solid var(--primary-green);
      color: var(--forest-green);
      border-radius: 6px;
      cursor: pointer;
    }
    .btn-ack:hover { background: var(--primary-green); color: white; }
    
    footer {
      text-align: center;
      margin-top: 48px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <div class="brand-eyebrow">Sistem Deteksi Pembalakan Liar</div>
        <h1>ALoRa Web Dashboard</h1>
      </div>
      <div class="conn-status">
        <span class="conn-dot" id="connDot"></span>
        <span id="connLabel">Menghubungkan…</span>
      </div>
    </header>

    <div class="hero" id="heroCard">
      <div class="pulse-circle" id="heroPulse">
        <span class="pulse-icon" id="heroIcon">🌲</span>
      </div>
      <div class="hero-info">
        <div class="hero-eyebrow">Status Kawasan</div>
        <div class="hero-title" id="heroStatusText">Memuat Data...</div>
        <div class="hero-desc" id="heroDescText">Menghubungkan ke gerbang data ALoRa...</div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Suhu &amp; Keamanan</div>
        <div class="stat-val" id="statNodesCount">–</div>
        <div class="stat-sub">Node aktif terpantau</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Ancaman Baru</div>
        <div class="stat-val" id="statUnackCount">–</div>
        <div class="stat-sub">Butuh peninjauan segera</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Gateway Status</div>
        <div class="stat-val" style="font-size: 16px; margin-top: 10px;" id="statLastSeenText">–</div>
        <div class="stat-sub">Laporan terakhir</div>
      </div>
    </div>

    <div class="main-layout">
      <div>
        <div class="slider-box">
          <div class="slider-header">
            <h3 class="card-title" style="margin-bottom:0">Sensitivitas Deteksi Alat</h3>
            <span class="slider-val" id="sensVal">75%</span>
          </div>
          <input type="range" id="sensRange" min="1" max="100" value="75">
          <p style="font-size:12px; color:var(--text-muted)">Semakin tinggi sensitivitas, semakin peka mikrofon mendeteksi suara gergaji dalam radius jauh hulu sungai.</p>
        </div>

        <div class="list-box">
          <h3 class="card-title">Daftar Node Sensor</h3>
          <div id="nodeListContainer">
            <!-- Dinamis -->
          </div>
        </div>
      </div>

      <div>
        <div class="list-box">
          <h3 class="card-title">Linimasa Peringatan</h3>
          <div class="timeline" id="timelineContainer">
            <!-- Dinamis -->
          </div>
        </div>
      </div>
    </div>

    <footer>
      ALoRa Acoustic Long Range • Hak Cipta Terlindungi 2026
    </footer>
  </div>

  <script>
    const FIREBASE_HOST = "lora-c0e72-default-rtdb.asia-southeast1.firebasedatabase.app";
    const FIREBASE_URL = "https://" + FIREBASE_HOST;
    
    // UI Selectors
    const connDot = document.getElementById("connDot");
    const connLabel = document.getElementById("connLabel");
    const heroPulse = document.getElementById("heroPulse");
    const heroIcon = document.getElementById("heroIcon");
    const heroStatusText = document.getElementById("heroStatusText");
    const heroDescText = document.getElementById("heroDescText");
    const statNodesCount = document.getElementById("statNodesCount");
    const statUnackCount = document.getElementById("statUnackCount");
    const statLastSeenText = document.getElementById("statLastSeenText");
    const sensRange = document.getElementById("sensRange");
    const sensVal = document.getElementById("sensVal");
    const nodeListContainer = document.getElementById("nodeListContainer");
    const timelineContainer = document.getElementById("timelineContainer");

    let latestAlerts = {};
    let latestNodes = {};

    // Firmware mengirim unix timestamp dalam detik, JS butuh milidetik.
    function toMs(ts) {
      if (!ts) return 0;
      return ts < 1e12 ? ts * 1000 : ts;
    }

    function timeAgo(unixTs) {
      const unixMs = toMs(unixTs);
      if(!unixMs) return "–";
      const diff = Math.floor((Date.now() - unixMs) / 1000);
      if(diff < 5) return "baru saja";
      if(diff < 60) return diff + " detik lalu";
      if(diff < 3600) return Math.floor(diff/60) + " menit lalu";
      return Math.floor(diff/3600) + " jam lalu";
    }

    async function fetchData() {
      try {
        const [statusRes, nodesRes, alertsRes, sensRes] = await Promise.all([
          fetch(FIREBASE_URL + "/status.json").then(r => r.json()),
          fetch(FIREBASE_URL + "/nodes.json").then(r => r.json()),
          fetch(FIREBASE_URL + "/alerts.json").then(r => r.json()),
          fetch(FIREBASE_URL + "/control/sensitivity.json").then(r => r.json())
        ]);

        connDot.className = "conn-dot";
        connLabel.textContent = "Terhubung (Firebase)";

        // Last seen
        const lastSeen = statusRes?.last_seen || null;
        statLastSeenText.textContent = lastSeen ? timeAgo(lastSeen) : "Belum ada lapor";

        // Nodes rendering
        latestNodes = nodesRes || {};
        const nodeEntries = Object.entries(latestNodes);
        statNodesCount.textContent = nodeEntries.length;

        if(nodeEntries.length === 0) {
          nodeListContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Belum melapor.</div>';
        } else {
          nodeListContainer.innerHTML = nodeEntries.map(([id, n]) => {
            return \`
              <div class="node-item">
                <div class="node-info">
                  <span class="node-dot"></span>
                  <div>
                    <span class="node-name">\${n.name || id}</span>
                    <div class="node-gps">\${n.lat || '–'}, \${n.lng || '–'}</div>
                  </div>
                </div>
                <a class="btn-maps" href="https://www.google.com/maps?q=\${n.lat},\${n.lng}" target="_blank">Google Maps ↗</a>
              </div>
            \`;
          }).join('');
        }

        // Alerts & Status
        const alerts = alertsRes ? Object.entries(alertsRes).map(([key, val]) => ({
          id: key,
          ...val
        })).sort((a,b) => b.timestamp - a.timestamp) : [];

        const unackAlerts = alerts.filter(a => !a.acknowledged);
        statUnackCount.textContent = unackAlerts.length;

        // Check fresh active threats
        if (unackAlerts.length > 0) {
          const mainThreat = unackAlerts[0];
          heroPulse.className = "pulse-circle alert";
          heroIcon.textContent = "🚨";
          heroStatusText.className = "hero-title alert";
          heroStatusText.textContent = "AKTIVITAS GERGAJI MESIN";
          heroDescText.textContent = "Pembalakan liar terdeteksi di Node " + mainThreat.node_id + " - " + timeAgo(mainThreat.timestamp);
        } else {
          heroPulse.className = "pulse-circle";
          heroIcon.textContent = "🌲";
          heroStatusText.className = "hero-title";
          heroStatusText.textContent = "Kawasan Hutan Aman";
          heroDescText.textContent = lastSeen ? "Sistem bekerja optimal, gateway melapor " + timeAgo(lastSeen) : "Tidak ada ancaman terdeteksi";
        }

        // Timeline rendering
        if(alerts.length === 0) {
          timelineContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Belum ada riwayat alarm.</div>';
        } else {
          timelineContainer.innerHTML = alerts.slice(0, 8).map(a => {
            return \`
              <div class="timeline-item \${a.acknowledged ? 'ack' : ''}">
                <div class="time-stamp">\${new Date(toMs(a.timestamp)).toLocaleTimeString('id-ID')}</div>
                <div class="timeline-body">
                  <div>
                    <div class="alert-node-title">🚨 Node \${a.node_id}</div>
                    <div class="alert-desc">Keyakinan: \${a.confidence}% • \${a.acknowledged ? 'Sudah Ditinjau' : 'Belum Ditinjau'}</div>
                  </div>
                  \${!a.acknowledged ? \`<button class="btn-ack" onclick="ackAlert('\${a.id}')">Konfirmasi</button>\` : ''}
                </div>
              </div>
            \`;
          }).join('');
        }

        // Sensitivity
        if(typeof sensRes === 'number') {
          sensRange.value = sensRes;
          sensVal.textContent = sensRes + "%";
        }

      } catch (e) {
        connDot.className = "conn-dot offline";
        connLabel.textContent = "Koneksi Terputus / CORS";
        console.error(e);
      }
    }

    async function ackAlert(id) {
      try {
        await fetch(FIREBASE_URL + "/alerts/" + id + "/acknowledged.json", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(true)
        });
        fetchData();
      } catch (e) {
        alert("Gagal memperbarui database!");
      }
    }

    sensRange.addEventListener("change", async (e) => {
      const val = e.target.value;
      sensVal.textContent = val + "%";
      try {
        await fetch(FIREBASE_URL + "/control/sensitivity.json", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Number(val))
        });
      } catch (err) {
        console.error(err);
      }
    });

    fetchData();
    setInterval(fetchData, 5000);
  </script>
</body>
</html>`;

  const copyHtmlToClipboard = () => {
    navigator.clipboard.writeText(htmlCode);
    setCopiedHtml(true);
    setTimeout(() => setCopiedHtml(false), 3000);
  };

  return (
    <div className="min-h-screen bg-[#F9FBF7] text-slate-800 font-sans antialiased flex flex-col md:flex-row selection:bg-emerald-100 selection:text-emerald-950 relative overflow-x-hidden">
      {/* Sidebar / Branding Rail */}
      <div className="w-full md:w-24 bg-[#E8F0E3] border-b md:border-b-0 md:border-r border-[#D1DBCA] flex flex-row md:flex-col items-center py-4 md:py-8 px-4 justify-between shrink-0 relative z-20">
        <div className="flex flex-row md:flex-col items-center justify-between md:justify-start gap-4 md:gap-8 w-full md:w-auto">
          {/* Logo / Brand Icon */}
          <div className="w-12 h-12 bg-[#10B981] rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-200/50 transition-transform hover:scale-105 duration-300">
            <TreePine className="w-6 h-6 text-white" />
          </div>

          {/* Icons navigation rail */}
          <nav className="flex flex-row md:flex-col gap-3 md:gap-6">
            <div className="p-3 bg-white rounded-xl shadow-xs text-emerald-600 border border-[#D1DBCA]/40">
              <Layers className="w-5 h-5" />
            </div>
            <div className="p-3 text-slate-400 hover:text-emerald-800 transition-colors cursor-pointer">
              <History className="w-5 h-5" />
            </div>
            <div className="p-3 text-slate-400 hover:text-emerald-800 transition-colors cursor-pointer">
              <MapPin className="w-5 h-5" />
            </div>
          </nav>
        </div>

        {/* Vertical Branding label */}
        <div
          className="hidden md:block text-[10px] font-bold text-emerald-800 rotate-180 tracking-widest select-none mt-auto"
          style={{ writingMode: "vertical-rl" }}
        >
          ALORA • V.2.0
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col p-6 md:p-8 overflow-y-auto relative z-10">
        {/* Decorative ambient forest background glow */}
        <div className="absolute top-0 left-0 right-0 h-96 bg-linear-to-b from-[#E8F0E3]/40 to-transparent pointer-events-none z-0" />

        {/* Connection Status & Notification Bar */}
        <div className="mb-6 flex flex-wrap gap-2 items-center justify-between relative z-10">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium ${
                isConnected
                  ? "bg-emerald-50 text-emerald-800 border border-[#D1DBCA]"
                  : "bg-amber-50 text-amber-800 border border-amber-200"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${isConnected ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`}
              />
              {isConnected ? "Sistem Online" : "Terputus dari Firebase"}
            </span>

            {!isConnected && (
              <span
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-mono font-medium bg-amber-100 text-amber-900 border border-amber-200 cursor-help"
                title={syncError ?? "Gagal terhubung ke Firebase berkali-kali."}
              >
                <WifiOff className="w-3.5 h-3.5" />
                Tidak ada data real -- cek koneksi/Firebase Rules
              </span>
            )}
          </div>
          {!isConnected && syncError && (
            <p className="text-xs text-amber-700 font-mono mt-1">{syncError}</p>
          )}

          <div className="text-xs text-stone-500 font-mono flex items-center gap-2">
            <span>Terakhir sinkron: {lastSynced.toLocaleTimeString()}</span>
            <button
              onClick={fetchData}
              disabled={isSyncing}
              className="p-1.5 rounded-lg hover:bg-stone-100 border border-stone-200/40 disabled:opacity-50 transition-colors bg-white/60"
              title="Refresh Data"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-stone-700 ${isSyncing ? "animate-spin" : ""}`}
              />
            </button>
          </div>
        </div>

        {/* Brand Header */}
        <header className="mb-8 flex flex-col md:flex-row justify-between items-start gap-4 pb-6 border-b border-[#D1DBCA]/60 relative z-10">
          <div>
            <h1 className="text-4xl font-light text-emerald-950 tracking-tight mb-1 font-serif">
              ALoRa <span className="font-bold font-sans">Dashboard</span>
            </h1>
            <p className="text-slate-500 font-medium italic text-sm">
              Acoustic Long Range Illegal Logging Detection System
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setShowHtmlExport(!showHtmlExport)}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-semibold border transition-all ${
                showHtmlExport
                  ? "bg-emerald-800 text-white border-emerald-800 shadow-md"
                  : "bg-white text-stone-700 border-[#D1DBCA] hover:bg-stone-50 hover:shadow-xs"
              }`}
            >
              <Copy className="w-3.5 h-3.5" />
              {showHtmlExport ? "Tutup Exporter" : "Dapatkan Kode HTML"}
            </button>
          </div>
        </header>

        {/* HTML Code Copy / Info Box */}
        <AnimatePresence>
          {showHtmlExport && (
            <motion.div
              initial={{ opacity: 0, y: -15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="mb-8 p-6 bg-white border border-[#D1DBCA] rounded-4xl shadow-xs relative z-10"
            >
              <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-4">
                <div>
                  <h3 className="font-serif text-lg font-medium text-emerald-900">
                    Ekspor Kode Dashboard untuk ESP32 / Server Lokal
                  </h3>
                  <p className="text-stone-500 text-xs mt-1">
                    Salin kode HTML tunggal di bawah ini untuk digunakan
                    langsung dalam folder lokal Anda, atau upload ke ESP32
                    Gateway Web Server.
                  </p>
                </div>
                <button
                  onClick={copyHtmlToClipboard}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition-colors border border-emerald-200"
                >
                  {copiedHtml ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      Tersalin!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Salin Kode HTML
                    </>
                  )}
                </button>
              </div>

              <div className="relative">
                <pre className="text-xs bg-stone-900 text-stone-200 p-4 rounded-2xl max-h-60 overflow-y-auto font-mono scrollbar-thin">
                  {htmlCode}
                </pre>
                <div className="absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-stone-900 to-transparent pointer-events-none rounded-b-2xl" />
              </div>

              <div className="mt-4 flex gap-3 p-4 bg-[#FAFBF7] rounded-2xl border border-emerald-100 text-xs text-stone-600">
                <Info className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-stone-800">
                    Catatan Integrasi:
                  </span>{" "}
                  Pastikan Anda menyesuaikan variabel{" "}
                  <code className="font-mono bg-stone-100 px-1 py-0.5 rounded text-emerald-800">
                    FIREBASE_HOST
                  </code>{" "}
                  di dalam kode HTML tersebut agar menunjuk ke database Realtime
                  Anda sendiri yang valid.
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hero Pulser Threat Level Widget (Major Alert Status Card) */}
        <div
          className={`mb-8 p-6 md:p-8 rounded-4xl border transition-all duration-300 relative overflow-hidden ${
            hasActiveAlert
              ? "bg-red-50/90 border-red-200 shadow-sm"
              : "bg-white border-[#D1DBCA] shadow-sm"
          }`}
        >
          {/* Decorative organic tree background ring */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#F2F9ED] rounded-full -mr-20 -mt-20 z-0 opacity-50" />

          <div className="flex flex-col md:flex-row items-center gap-8 relative z-10">
            <div className="relative shrink-0">
              <div
                className={`w-24 h-24 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${
                  hasActiveAlert
                    ? "bg-red-100 border-red-500 text-red-600 shadow-lg shadow-red-200"
                    : "bg-emerald-50 border-emerald-500 text-emerald-600 shadow-lg shadow-emerald-200/50"
                }`}
              >
                {hasActiveAlert ? (
                  <AlertTriangle className="w-10 h-10 animate-bounce" />
                ) : (
                  <ShieldCheck className="w-10 h-10" />
                )}
              </div>

              {/* Pulsing rings around state */}
              <span
                className={`absolute -inset-2 rounded-full border-2 animate-ping opacity-25 ${
                  hasActiveAlert ? "border-red-400" : "border-emerald-400"
                }`}
              />
              <span
                className={`absolute -inset-5 rounded-full border-2 animate-pulse opacity-15 delay-150 ${
                  hasActiveAlert ? "border-red-300" : "border-emerald-300"
                }`}
              />
            </div>

            <div className="flex-1 text-center md:text-left">
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 mb-2">
                <span
                  className={`font-mono text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full ${
                    hasActiveAlert
                      ? "bg-red-100 text-red-800"
                      : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  Real-time Status
                </span>

                {hasActiveAlert && (
                  <span className="bg-red-500 text-white text-[10px] font-bold uppercase font-mono px-2 py-0.5 rounded-full animate-pulse">
                    Peringatan Bahaya
                  </span>
                )}
              </div>

              <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div>
                  <h2 className="text-sm text-slate-400 font-bold uppercase tracking-wider mb-2">
                    Kondisi Hutan Saat Ini
                  </h2>
                  <div className="flex items-center justify-center md:justify-start gap-4">
                    <span
                      className={`text-6xl md:text-7xl font-black leading-none tracking-tighter ${
                        hasActiveAlert ? "text-red-600" : "text-emerald-600"
                      }`}
                    >
                      {hasActiveAlert ? "TERANCAM" : "AMAN"}
                    </span>
                  </div>
                  <p className="text-stone-500 text-sm mt-2 max-w-xl">
                    {hasActiveAlert
                      ? `Gergaji mesin SEDANG terdeteksi live di Node ${latestActiveNodeId}. Segera arahkan tim patroli rimbawan ke koordinat lokasi. Status ini otomatis kembali AMAN begitu node melaporkan situasi reda.`
                      : "Sistem akustik tidak menangkap adanya sinyal frekuensi abnormal yang menyerupai gergaji mesin (chainsaw) dari node yang sedang online. Konservasi hutan aman dari pembalakan liar."}
                  </p>
                </div>

                <div className="border-t md:border-t-0 md:border-l border-slate-200/80 pt-4 md:pt-0 md:pl-8 flex flex-row md:flex-col justify-around md:justify-start gap-4 shrink-0 text-left">
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Last Detection
                    </p>
                    <p
                      className={`text-lg font-bold italic ${hasActiveAlert ? "text-red-700" : "text-slate-700"}`}
                    >
                      {hasActiveAlert && latestActiveNodeId
                        ? `Node ${latestActiveNodeId}`
                        : "Tidak Ada"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Alert Belum Ditinjau
                    </p>
                    <p
                      className={`text-lg font-bold ${unacknowledgedAlerts.length > 0 ? "text-amber-600" : "text-emerald-600"}`}
                    >
                      {unacknowledgedAlerts.length}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 3 Stats Overview Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white border border-[#D1DBCA] p-6 rounded-3xl shadow-sm hover:shadow-md transition-all duration-300">
            <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase mb-2">
              Jumlah Node Sensor
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-serif text-4xl font-semibold text-emerald-900 leading-none">
                {Object.keys(nodes).length}
              </span>
              <span className="text-stone-400 text-xs font-semibold">
                Alat Aktif
              </span>
            </div>
            <div className="text-[11px] text-stone-500 mt-4 flex items-center gap-1.5 font-medium">
              <MapPin className="w-3.5 h-3.5 text-emerald-700" />
              Titik sebaran sensor LoRa ESP32
            </div>
          </div>

          <div className="bg-white border border-[#D1DBCA] p-6 rounded-3xl shadow-sm hover:shadow-md transition-all duration-300">
            <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase mb-2">
              Peringatan Belum Ditinjau
            </div>
            <div className="flex items-baseline gap-2">
              <span
                className={`font-serif text-4xl font-semibold leading-none ${unacknowledgedAlerts.length > 0 ? "text-red-600 animate-pulse" : "text-emerald-950"}`}
              >
                {unacknowledgedAlerts.length}
              </span>
              <span className="text-stone-400 text-xs font-semibold">
                Belum Dikonfirmasi
              </span>
            </div>
            <div className="text-[11px] text-stone-500 mt-4 flex items-center gap-1.5 font-medium">
              <History className="w-3.5 h-3.5 text-emerald-700" />
              Butuh verifikasi manual tim rimbawan
            </div>
          </div>

          <div className="bg-[#1A2C1F] text-white p-6 rounded-3xl shadow-md hover:shadow-lg transition-all duration-300 flex flex-col justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400 mb-2">
                Gateway Terakhir Lapor
              </p>
              <h3 className="text-2xl font-serif font-bold tracking-tight text-white">
                {status?.last_seen
                  ? timeAgo(status.last_seen)
                  : "Belum melapor"}
              </h3>
            </div>
            <div className="flex justify-between items-center text-[11px] font-medium text-emerald-400 mt-4">
              <span className="flex items-center gap-1">
                <Radio className="w-3.5 h-3.5" /> ESP32-WROOM
              </span>
              <span>915 MHz LoRa</span>
            </div>
          </div>
        </div>

        {/* Dashboard Core Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 relative z-10">
          {/* Main Panel (Left & center) */}
          <div className="lg:col-span-2 space-y-8">
            {/* Interactive Sensitivity Controller Card */}
            <div className="bg-white border border-[#D1DBCA] rounded-4xl p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="w-5 h-5 text-emerald-800" />
                  <div>
                    <h3 className="font-serif text-lg font-bold text-emerald-950 tracking-tight">
                      Ambang Batas &amp; Sensitivitas Deteksi
                    </h3>
                    <p className="text-xs text-stone-500 font-medium">
                      Sinkronisasi otomatis ke memori flash ESP32 Gateway via
                      LoRa.
                    </p>
                  </div>
                </div>

                <div className="bg-emerald-50 border border-[#D1DBCA] text-emerald-900 font-mono text-xs font-bold px-3 py-1 rounded-full">
                  Nilai: {sensitivity}%
                </div>
              </div>

              <div className="my-6">
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={sensitivity}
                  onChange={(e) => updateSensitivity(Number(e.target.value))}
                  className="w-full h-2 bg-stone-100 rounded-lg appearance-none cursor-pointer accent-emerald-600 focus:outline-none"
                />
                <div className="flex justify-between text-[9px] text-stone-400 font-mono mt-2 font-semibold">
                  <span>Paling Redup (Filter ketat)</span>
                  <span>Menengah (50%)</span>
                  <span>Sangat Peka (Paling sensitif)</span>
                </div>
              </div>

              <div className="p-4 bg-[#F2F9ED] rounded-2xl border border-[#D1DBCA]/60 text-xs text-stone-600 flex gap-3">
                <Info className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-stone-800">
                    Umpan balik ML Node:
                  </span>{" "}
                  Nilai saat ini mengarahkan ESP32 Node untuk menggunakan ambang
                  batas gergaji setara dengan{" "}
                  <code className="bg-white/80 border border-[#D1DBCA]/40 px-1.5 py-0.5 rounded font-bold text-emerald-900">
                    {(0.9 - (sensitivity / 100.0) * 0.7).toFixed(2)}
                  </code>{" "}
                  probabilitas klasifikasi.
                </div>
              </div>
            </div>

            {/* Izin Tebang (Permit Scheduling) Card */}
            <div className="bg-white border border-[#D1DBCA] rounded-4xl p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div>
                  <h3 className="font-serif text-lg font-bold text-emerald-950 tracking-tight">
                    Jadwal Izin Tebang Resmi
                  </h3>
                  <p className="text-xs text-stone-500 font-medium">
                    Selama rentang waktu ini aktif, deteksi gergaji mesin tidak
                    memicu alarm/notifikasi ilegal.
                  </p>
                </div>
                <span
                  className={`px-3 py-1 rounded-full text-xs font-mono font-bold ${
                    permit &&
                    Date.now() >= permit.start_ts &&
                    Date.now() <= permit.end_ts
                      ? "bg-amber-100 text-amber-800 border border-amber-300"
                      : "bg-stone-100 text-stone-600 border border-stone-200"
                  }`}
                >
                  {permit &&
                  Date.now() >= permit.start_ts &&
                  Date.now() <= permit.end_ts
                    ? "🟡 Izin Sedang Aktif"
                    : "⛔ Tidak Ada Izin Aktif"}
                </span>
              </div>

              {permit && (
                <div className="mb-4 p-3 bg-[#F2F9ED] rounded-2xl border border-[#D1DBCA]/60 text-xs text-stone-700">
                  <div>
                    <strong>Mulai:</strong>{" "}
                    {new Date(permit.start_ts).toLocaleString("id-ID")}
                  </div>
                  <div>
                    <strong>Selesai:</strong>{" "}
                    {new Date(permit.end_ts).toLocaleString("id-ID")}
                  </div>
                  {permit.note && (
                    <div>
                      <strong>Catatan:</strong> {permit.note}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-mono font-bold text-stone-500 uppercase mb-1">
                    Mulai (tanggal &amp; jam)
                  </label>
                  <input
                    type="datetime-local"
                    value={permitStartInput}
                    onChange={(e) => setPermitStartInput(e.target.value)}
                    className="w-full text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono font-bold text-stone-500 uppercase mb-1">
                    Selesai (tanggal &amp; jam)
                  </label>
                  <input
                    type="datetime-local"
                    value={permitEndInput}
                    onChange={(e) => setPermitEndInput(e.target.value)}
                    className="w-full text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[10px] font-mono font-bold text-stone-500 uppercase mb-1">
                    Catatan (opsional, mis. nomor SK/izin)
                  </label>
                  <input
                    type="text"
                    value={permitNoteInput}
                    onChange={(e) => setPermitNoteInput(e.target.value)}
                    placeholder="mis. Izin Dishut No. 123/2026"
                    className="w-full text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-4">
                <button
                  onClick={savePermit}
                  disabled={isSavingPermit}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl shadow-2xs transition-colors disabled:opacity-50"
                >
                  Simpan Jadwal Izin
                </button>
                {permit && (
                  <button
                    onClick={clearPermit}
                    disabled={isSavingPermit}
                    className="px-4 py-2 bg-white border border-[#D1DBCA] hover:bg-stone-50 text-stone-700 text-xs font-bold rounded-xl transition-colors disabled:opacity-50"
                  >
                    Hapus Izin
                  </button>
                )}
              </div>

              {/* Riwayat Izin Tebang: semua izin yang PERNAH dibuat, terpisah
                  dari jadwal aktif di atas -- supaya bisa dilihat berapa kali
                  izin tebang pernah diterbitkan sepanjang waktu. */}
              <div className="mt-6 pt-4 border-t border-stone-100">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-serif text-sm font-bold text-emerald-950">
                    Riwayat Izin Tebang
                  </h4>
                  <div className="flex items-center gap-2">
                    <span className="bg-stone-100 text-stone-600 font-mono text-[10px] font-bold px-2 py-0.5 rounded-full border border-stone-200">
                      {Object.keys(permitHistory).length}x pernah dibuat
                    </span>
                    {Object.keys(permitHistory).length > 0 && (
                      <button
                        onClick={clearAllPermitHistory}
                        className="px-2.5 py-1 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-[10px] font-bold rounded-lg transition-colors"
                      >
                        Hapus Semua
                      </button>
                    )}
                  </div>
                </div>

                {Object.keys(permitHistory).length === 0 ? (
                  <p className="text-xs text-stone-400 py-2">
                    Belum ada riwayat izin tebang yang tercatat.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {(Object.values(permitHistory) as PermitHistoryEntry[])
                      .sort((a, b) => b.created_at - a.created_at)
                      .map((entry) => (
                        <div
                          key={entry.id}
                          className="flex items-start justify-between gap-2 p-2.5 bg-[#FAFBF7] border border-[#D1DBCA]/60 rounded-xl text-xs"
                        >
                          <div>
                            <div className="text-stone-700 font-medium">
                              {new Date(entry.start_ts).toLocaleString("id-ID")}{" "}
                              &rarr;{" "}
                              {new Date(entry.end_ts).toLocaleString("id-ID")}
                            </div>
                            {entry.note && (
                              <div className="text-stone-500 text-[11px] mt-0.5">
                                {entry.note}
                              </div>
                            )}
                            <div className="text-stone-400 text-[10px] font-mono mt-0.5">
                              Dibuat {formatTimestamp(entry.created_at)}
                            </div>
                          </div>
                          <button
                            onClick={() => deletePermitHistoryEntry(entry.id)}
                            className="shrink-0 px-2 py-1 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-[10px] font-bold rounded-lg transition-colors"
                          >
                            Hapus
                          </button>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>

            {/* NEW: Animated Acoustic Fingerprint Visualizer Card */}
            <div className="bg-[#1A2C1F] text-white border border-emerald-900 rounded-4xl p-6 shadow-md relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-800 rounded-full -mr-12 -mt-12 opacity-30 blur-2xl" />

              <div className="flex justify-between items-start mb-4 relative z-10">
                <div>
                  <span className="font-mono text-[9px] text-emerald-400 font-bold uppercase tracking-widest">
                    Acoustic Signal Processing
                  </span>
                  <h3 className="font-serif text-lg font-medium text-white">
                    Spektrogram &amp; Sidik Jari Akustik Hutan
                  </h3>
                </div>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider ${
                    hasActiveAlert
                      ? "bg-red-500 text-white animate-pulse"
                      : "bg-emerald-800 text-emerald-300"
                  }`}
                >
                  {hasActiveAlert
                    ? "Ancaman Terdeteksi"
                    : "Monitoring Frekuensi"}
                </span>
              </div>

              {/* Animated Waveform Display */}
              <div className="h-28 bg-[#0F1E14] rounded-2xl border border-emerald-800/40 flex items-end justify-between p-4 gap-1 relative overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,0.08),transparent)] pointer-events-none" />

                {/* 28 individual sound spectrum bars with random heights and custom animation delays */}
                {[
                  55, 30, 45, 75, 90, 60, 40, 25, 35, 60, 85, 95, 70, 50, 40,
                  30, 45, 65, 80, 55, 35, 40, 60, 80, 70, 50, 30, 20,
                ].map((h, i) => {
                  // Speed up the animation if alert is active
                  const animStyle = hasActiveAlert
                    ? {
                        animationDelay: `${i * 0.04}s`,
                        animationDuration: `${0.4 + (i % 3) * 0.2}s`,
                      }
                    : {
                        animationDelay: `${i * 0.08}s`,
                        animationDuration: `${1.2 + (i % 4) * 0.4}s`,
                      };

                  return (
                    <div
                      key={i}
                      className={`w-full rounded-t-full transition-all duration-300 ${
                        hasActiveAlert
                          ? "bg-linear-to-t from-red-600 to-amber-400"
                          : "bg-linear-to-t from-emerald-600 to-emerald-400"
                      }`}
                      style={{
                        height: `${h}%`,
                        animation: "bounceWave infinite ease-in-out",
                        ...animStyle,
                      }}
                    />
                  );
                })}
              </div>

              {/* Spectrogram Stats Indicator */}
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-emerald-900/60 pt-4 text-xs">
                <div>
                  <span className="block text-[10px] text-emerald-400/80 font-mono uppercase tracking-wider">
                    Sampling Rate
                  </span>
                  <span className="font-semibold text-white">
                    16.0 kHz (INMP441)
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] text-emerald-400/80 font-mono uppercase tracking-wider">
                    Algoritma FFT
                  </span>
                  <span className="font-semibold text-white">
                    64-bin EdgeImpulse
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] text-emerald-400/80 font-mono uppercase tracking-wider">
                    Transmisi LoRa
                  </span>
                  <span className="font-semibold text-white">
                    Sinyal SF7 BW125
                  </span>
                </div>
              </div>

              {/* Custom CSS for the waveform animation injected directly */}
              <style>{`
                @keyframes bounceWave {
                  0%, 100% { transform: scaleY(0.4); }
                  50% { transform: scaleY(1); }
                }
              `}</style>
            </div>

            {/* Node Terdeteksi, Perlu Didaftarkan */}
            {/* Panel ini yang menjawab alur yang benar: node sensor aktif ->
                gateway meneruskan paket pertamanya -> node OTOMATIS muncul di
                Firebase (via PATCH) HANYA dengan status hidup, TANPA nama/lokasi
                -> baru di sinilah admin memberi nama kustom + koordinat GPS
                sebenarnya di lapangan. Setelah didaftarkan, gateway tidak akan
                pernah menimpa nama/koordinat itu lagi. */}
            {unregisteredNodeEntries.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-4xl p-6 shadow-sm">
                <div className="mb-4">
                  <h3 className="font-serif text-lg font-bold text-amber-900 tracking-tight flex items-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    Node Terdeteksi, Perlu Didaftarkan
                  </h3>
                  <p className="text-xs text-amber-800/80 font-medium">
                    Node ini sudah aktif mengirim data lewat gateway (ID
                    perangkatnya tetap/tidak bisa diubah), tapi belum punya nama
                    & koordinat. Isi dulu di bawah ini supaya muncul di peta
                    &amp; daftar node.
                  </p>
                </div>

                <div className="space-y-3">
                  {unregisteredNodeEntries.map(([id]) => (
                    <div
                      key={id}
                      className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-center bg-white border border-amber-200 rounded-2xl p-3"
                    >
                      <span className="font-mono text-xs font-bold text-amber-900">
                        ID: {id}
                      </span>
                      <input
                        type="text"
                        placeholder="Nama kustom"
                        value={regNameInput[id] || ""}
                        onChange={(e) =>
                          setRegNameInput((prev) => ({
                            ...prev,
                            [id]: e.target.value,
                          }))
                        }
                        className="text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                      />
                      <input
                        type="text"
                        placeholder="Latitude"
                        value={regLatInput[id] || ""}
                        onChange={(e) =>
                          setRegLatInput((prev) => ({
                            ...prev,
                            [id]: e.target.value,
                          }))
                        }
                        className="text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="Longitude"
                          value={regLngInput[id] || ""}
                          onChange={(e) =>
                            setRegLngInput((prev) => ({
                              ...prev,
                              [id]: e.target.value,
                            }))
                          }
                          className="flex-1 text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                        />
                        <button
                          onClick={() => registerNode(id)}
                          disabled={isRegistering === id}
                          className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl shadow-2xs transition-colors disabled:opacity-50 whitespace-nowrap"
                        >
                          Daftarkan
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Manajemen Node Card */}
            <div className="bg-white border border-[#D1DBCA] rounded-4xl p-6 shadow-sm">
              <div className="mb-4">
                <h3 className="font-serif text-lg font-bold text-emerald-950 tracking-tight">
                  Manajemen Node
                </h3>
                <p className="text-xs text-stone-500 font-medium">
                  Node fisik yang sudah aktif otomatis muncul di panel "Perlu
                  Didaftarkan" di atas begitu gateway menerima paket pertamanya
                  -- daftarkan nama &amp; koordinatnya di sana. Form di bawah
                  ini untuk kasus lain: menambah node secara manual sebelum alat
                  dipasang, mengubah koordinat/nama node yang sudah terdaftar,
                  atau menghapus node yang tidak dipakai. Gateway tidak akan
                  pernah menimpa nama/koordinat yang sudah kamu isi di sini.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-2">
                <input
                  type="text"
                  placeholder="ID node (mis. node-3)"
                  value={newNodeId}
                  onChange={(e) => setNewNodeId(e.target.value)}
                  className="text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                />
                <input
                  type="text"
                  placeholder="Latitude"
                  value={newNodeLat}
                  onChange={(e) => setNewNodeLat(e.target.value)}
                  className="text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                />
                <input
                  type="text"
                  placeholder="Longitude"
                  value={newNodeLng}
                  onChange={(e) => setNewNodeLng(e.target.value)}
                  className="text-sm border border-[#D1DBCA] rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                />
                <button
                  onClick={addNode}
                  disabled={isSavingNode}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl shadow-2xs transition-colors disabled:opacity-50"
                >
                  + Tambah Node
                </button>
              </div>

              <div className="divide-y divide-stone-100 mt-4">
                {registeredNodeEntries.map(([id, node]: [string, any]) => {
                  const isOffline =
                    node.last_seen &&
                    Date.now() - node.last_seen > NODE_OFFLINE_THRESHOLD_MS;
                  return (
                    <div
                      key={id}
                      className="flex flex-wrap items-center justify-between gap-2 py-3"
                    >
                      <div className="flex items-center gap-2 text-xs">
                        <span
                          className={`w-2 h-2 rounded-full ${isOffline ? "bg-stone-300" : "bg-emerald-500"}`}
                        />
                        {editingNameNodeId === id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={editNameValue}
                              onChange={(e) => setEditNameValue(e.target.value)}
                              placeholder="Nama kustom node"
                              className="w-32 text-xs border border-[#D1DBCA] rounded-lg px-2 py-1"
                            />
                            <button
                              onClick={() => saveNodeName(id)}
                              disabled={isSavingName}
                              className="px-2 py-1 bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-bold rounded-lg disabled:opacity-50"
                            >
                              Simpan
                            </button>
                            <button
                              onClick={() => setEditingNameNodeId(null)}
                              className="px-2 py-1 bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold rounded-lg"
                            >
                              Batal
                            </button>
                          </div>
                        ) : (
                          <>
                            <span className="font-semibold text-stone-800">
                              {node.name || id}
                            </span>
                            <span className="font-mono text-[9px] text-stone-400 bg-stone-50 border border-stone-150 px-1.5 py-0.5 rounded-full">
                              ID: {id}
                            </span>
                            <button
                              onClick={() => {
                                setEditingNameNodeId(id);
                                setEditNameValue(node.name || "");
                              }}
                              title="Ganti nama tampilan node ini (ID perangkat tetap tidak berubah)"
                              className="px-2 py-0.5 bg-white border border-[#D1DBCA] hover:bg-stone-50 text-stone-500 text-[10px] font-bold rounded-lg"
                            >
                              Ganti Nama
                            </button>
                          </>
                        )}
                        {isOffline && (
                          <span className="text-[10px] font-mono font-bold text-stone-500 bg-stone-100 px-2 py-0.5 rounded-full border border-stone-200">
                            Tidak terdeteksi sejak {timeAgo(node.last_seen)}
                          </span>
                        )}
                      </div>

                      {editingNodeId === id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={editLat}
                            onChange={(e) => setEditLat(e.target.value)}
                            className="w-20 text-xs border border-[#D1DBCA] rounded-lg px-2 py-1"
                          />
                          <input
                            type="text"
                            value={editLng}
                            onChange={(e) => setEditLng(e.target.value)}
                            className="w-20 text-xs border border-[#D1DBCA] rounded-lg px-2 py-1"
                          />
                          <button
                            onClick={() => saveNodeCoords(id)}
                            className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-800 text-white text-[10px] font-bold rounded-lg"
                          >
                            Simpan
                          </button>
                          <button
                            onClick={() => setEditingNodeId(null)}
                            className="px-2.5 py-1 bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold rounded-lg"
                          >
                            Batal
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[11px] text-stone-500">
                            {node.lat}, {node.lng}
                          </span>
                          <button
                            onClick={() => {
                              setEditingNodeId(id);
                              setEditLat(String(node.lat));
                              setEditLng(String(node.lng));
                            }}
                            className="px-2.5 py-1 bg-white border border-[#D1DBCA] hover:bg-stone-50 text-stone-600 text-[10px] font-bold rounded-lg"
                          >
                            Edit Koordinat
                          </button>
                          <button
                            onClick={() => deleteNode(id)}
                            className="px-2.5 py-1 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-[10px] font-bold rounded-lg"
                          >
                            Hapus
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Acoustic Map Canvas Card */}
            <div className="bg-white border border-[#D1DBCA] rounded-4xl p-6 shadow-sm">
              <div className="mb-4">
                <h3 className="font-serif text-lg font-bold text-emerald-950 tracking-tight">
                  Visualisasi Sebaran Sensor Spasial
                </h3>
                <p className="text-xs text-stone-500 font-medium">
                  Koordinat geografis relatif pada grid persebaran wilayah hutan
                  konservasi hulu.
                </p>
              </div>

              {/* Styled Minimal Grid Canvas Map */}
              <div className="bg-[#FAFBF7] rounded-2xl border border-[#D1DBCA]/80 p-6 flex flex-col items-center justify-center relative overflow-hidden">
                {/* Visual grid pattern */}
                <div className="absolute inset-0 bg-[linear-gradient(to_right,#e6ebe1_1px,transparent_1px),linear-gradient(to_bottom,#e6ebe1_1px,transparent_1px)] bg-size-[40px_40px] opacity-40" />

                {/* Concentric nature tree ring decorations */}
                <div className="absolute w-80 h-80 rounded-full border border-emerald-100/30 opacity-40 pointer-events-none" />
                <div className="absolute w-100 h-100 rounded-full border border-emerald-100/20 opacity-30 pointer-events-none" />

                <div className="relative w-full h-64 flex items-center justify-center">
                  {/* Safe Central Watch Tower base marker */}
                  <div className="absolute flex flex-col items-center">
                    <div className="bg-[#1A2C1F] text-emerald-400 p-3 rounded-2xl shadow-md z-15 border border-[#D1DBCA]/40">
                      <Radio className="w-4 h-4 text-emerald-400" />
                    </div>
                    <span className="text-[9px] font-mono font-bold text-emerald-900 bg-white px-2 py-0.5 rounded-full border border-emerald-200 shadow-xs mt-2">
                      Gateway ALoRa
                    </span>
                  </div>

                  {/* Render nodes onto stylized grid */}
                  {registeredNodeEntries.map(
                    ([id, node]: [string, any], idx) => {
                      const nodeIsFresh =
                        !!node.last_seen &&
                        Date.now() - node.last_seen < NODE_OFFLINE_THRESHOLD_MS;
                      const isNodeAlerting =
                        node.detected === true && nodeIsFresh;

                      // Simple offset styling for visual spread
                      const offsetStyles = [
                        { left: "15%", top: "25%" },
                        { right: "18%", bottom: "20%" },
                        { left: "25%", bottom: "15%" },
                        { right: "15%", top: "30%" },
                      ];
                      const pos = offsetStyles[idx % offsetStyles.length];

                      return (
                        <div
                          key={id}
                          className="absolute flex flex-col items-center z-10 transition-all duration-300"
                          style={pos}
                        >
                          {/* Interactive Node Button Indicator */}
                          <div className="relative group cursor-pointer">
                            <span
                              className={`absolute -inset-2 rounded-full opacity-40 ${isNodeAlerting ? "bg-red-400 animate-ping" : "bg-emerald-400"}`}
                            />

                            <div
                              className={`w-9 h-9 rounded-full flex items-center justify-center shadow-md border transition-transform group-hover:scale-110 ${
                                isNodeAlerting
                                  ? "bg-red-500 border-red-400 text-white animate-bounce"
                                  : "bg-white border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                              }`}
                            >
                              <TreePine className="w-4 h-4" />
                            </div>

                            {/* Tooltip on Hover */}
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-stone-900 text-stone-100 text-[10px] p-3 rounded-xl shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none font-mono z-50">
                              <div className="font-bold text-emerald-400 mb-0.5">
                                {node.name || id}
                              </div>
                              <div>Lat: {node.lat}</div>
                              <div>Lng: {node.lng}</div>
                              <div
                                className={`mt-1 font-semibold ${isNodeAlerting ? "text-red-400" : "text-emerald-400"}`}
                              >
                                Status:{" "}
                                {isNodeAlerting
                                  ? "GERGAJI TERDETEKSI"
                                  : "Aman & Nyala"}
                              </div>
                            </div>
                          </div>

                          <span className="text-[10px] font-mono font-semibold text-stone-700 bg-white px-2.5 py-0.5 rounded-full border border-stone-200 mt-2 shadow-xs">
                            {node.name || id}
                          </span>
                        </div>
                      );
                    },
                  )}
                </div>

                <div className="w-full flex justify-between items-center mt-4 border-t border-stone-200/60 pt-4 relative z-10">
                  <div className="flex gap-4 text-[10px] font-mono text-stone-500">
                    <span className="flex items-center gap-1.5 font-semibold">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                      Node Aman
                    </span>
                    <span className="flex items-center gap-1.5 font-semibold">
                      <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                      Node Terancam
                    </span>
                  </div>

                  <span className="text-[10px] font-mono text-emerald-800 font-semibold italic">
                    *Arahkan kursor ke node untuk melihat koordinat GPS.
                  </span>
                </div>
              </div>
            </div>

            {/* Node Sensors Overview List */}
            <div className="bg-white border border-[#D1DBCA] rounded-4xl p-6 shadow-sm">
              <div className="mb-4">
                <h3 className="font-serif text-lg font-bold text-emerald-950 tracking-tight">
                  Daftar Node Sensor Aktif
                </h3>
                <p className="text-xs text-stone-500 font-medium">
                  Daftar terdaftar perangkat keras sensor ALoRa dalam wilayah
                  hutan lindung.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-stone-200 text-stone-400 text-[10px] font-mono uppercase tracking-wider">
                      <th className="py-3 px-2">Nama Node</th>
                      <th className="py-3 px-2">Garis Lintang (Lat)</th>
                      <th className="py-3 px-2">Garis Bujur (Lng)</th>
                      <th className="py-3 px-2">Kondisi</th>
                      <th className="py-3 px-2">Terakhir Aktif</th>
                      <th className="py-3 px-2">Log Belum Ditinjau</th>
                      <th className="py-3 px-2 text-right">Peta GPS</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm divide-y divide-stone-100">
                    {registeredNodeEntries.map(([id, node]: [string, any]) => {
                      const isOffline =
                        !node.last_seen ||
                        Date.now() - node.last_seen > NODE_OFFLINE_THRESHOLD_MS;
                      const isNodeAlerting =
                        node.detected === true && !isOffline;
                      const nodeUnackCount = (
                        Object.values(alerts) as AlertItem[]
                      ).filter(
                        (a) => a.node_id === id && !a.acknowledged,
                      ).length;

                      return (
                        <tr
                          key={id}
                          className="hover:bg-[#F9FBF7] transition-colors"
                        >
                          <td className="py-4 px-2 font-semibold text-stone-850">
                            <span className="flex items-center gap-2.5">
                              <span
                                className={`w-2.5 h-2.5 rounded-full ${
                                  isNodeAlerting
                                    ? "bg-red-500 animate-pulse"
                                    : isOffline
                                      ? "bg-stone-300"
                                      : "bg-emerald-500"
                                }`}
                              />
                              {node.name || id}
                            </span>
                          </td>
                          <td className="py-4 px-2 font-mono text-xs text-stone-500 font-medium">
                            {node.lat ?? "–"}
                          </td>
                          <td className="py-4 px-2 font-mono text-xs text-stone-500 font-medium">
                            {node.lng ?? "–"}
                          </td>
                          <td className="py-4 px-2">
                            <span
                              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold ${
                                isNodeAlerting
                                  ? "bg-red-50 text-red-800 border border-red-200"
                                  : isOffline
                                    ? "bg-stone-100 text-stone-600 border border-stone-200"
                                    : "bg-emerald-50 text-emerald-800 border border-emerald-100"
                              }`}
                            >
                              {isNodeAlerting
                                ? "🚨 Terancam"
                                : isOffline
                                  ? "⚪ Tidak Terdeteksi"
                                  : "✅ Aman"}
                            </span>
                          </td>
                          <td className="py-4 px-2 font-mono text-[11px] text-stone-500">
                            {node.last_seen
                              ? timeAgo(node.last_seen)
                              : "Belum pernah lapor"}
                          </td>
                          <td className="py-4 px-2">
                            {nodeUnackCount > 0 ? (
                              <button
                                onClick={() => acknowledgeNodeAlerts(id)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 rounded-lg text-[10px] font-bold transition-colors cursor-pointer"
                                title="Tandai semua log alarm milik node ini sebagai sudah ditinjau (node lain tidak terpengaruh)"
                              >
                                {nodeUnackCount} log · Tandai Ditinjau
                              </button>
                            ) : (
                              <span className="text-[10px] font-mono text-stone-400">
                                Tidak ada
                              </span>
                            )}
                          </td>
                          <td className="py-4 px-2 text-right">
                            <a
                              href={`https://www.google.com/maps?q=${node.lat},${node.lng}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#D1DBCA] hover:bg-[#FAFBF7] hover:border-emerald-300 text-stone-700 hover:text-emerald-950 rounded-xl text-xs font-semibold shadow-2xs transition-colors"
                            >
                              Maps
                              <ExternalLink className="w-3 h-3 text-stone-500" />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Sidebar Area (Right column) */}
          <div className="space-y-8">
            {/* Real-time Alert Timeline */}
            <div className="bg-white border border-[#D1DBCA] rounded-4xl p-6 shadow-sm">
              <div className="flex justify-between items-center mb-5 pb-3 border-b border-stone-100">
                <div>
                  <h3 className="font-serif text-lg font-bold text-emerald-950 tracking-tight">
                    Riwayat Alarm Deteksi
                  </h3>
                  <p className="text-xs text-stone-500 font-medium">
                    Log peristiwa akustik gergaji mesin terkini hulu sungai.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="bg-emerald-50 text-emerald-800 font-mono text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-100">
                    {alertList.length} total
                  </span>
                  {alertList.length > 0 && (
                    <button
                      onClick={deleteAllAlertsData}
                      title="Hapus seluruh data ancaman/log alarm secara permanen"
                      className="px-2.5 py-1 bg-white border border-red-200 hover:bg-red-50 text-red-600 text-[10px] font-bold rounded-lg transition-colors"
                    >
                      Hapus Semua
                    </button>
                  )}
                </div>
              </div>

              {alertList.length === 0 ? (
                <div className="py-12 text-center text-stone-400 text-xs">
                  <TreePine className="w-8 h-8 text-stone-300 mx-auto mb-2.5" />
                  Belum ada log peristiwa alarm yang tercatat dalam sistem.
                </div>
              ) : (
                <div className="relative border-l-2 border-stone-150 pl-4 space-y-6">
                  {alertList.slice(0, 10).map((alert: any) => (
                    <div key={alert.id} className="relative group">
                      {/* Timeline Dot Indicator */}
                      <span
                        className={`absolute -left-5.25 top-1.5 w-2.5 h-2.5 rounded-full border-2 border-white shadow-xs ${
                          alert.acknowledged
                            ? "bg-emerald-500"
                            : "bg-red-500 animate-pulse"
                        }`}
                      />

                      <div className="text-xs">
                        <span className="font-mono text-[10px] text-stone-400 block mb-1 font-semibold">
                          {formatTimestamp(alert.timestamp)}
                        </span>

                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <span
                              className={`font-bold font-sans text-sm ${alert.acknowledged ? "text-stone-700" : "text-red-950"}`}
                            >
                              🚨 Node {alert.node_id}
                            </span>
                            <div className="text-stone-500 text-[11px] mt-0.5 font-medium leading-relaxed">
                              Akurasi Edge Impulse ML:{" "}
                              <strong className="font-mono text-emerald-700">
                                {alert.confidence}%
                              </strong>
                            </div>
                            <div className="text-[11px] mt-1.5">
                              <span
                                className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-mono font-semibold ${
                                  alert.acknowledged
                                    ? "bg-stone-100 text-stone-600"
                                    : "bg-red-50 text-red-700 border border-red-200"
                                }`}
                              >
                                {alert.acknowledged
                                  ? "Ditinjau Aman"
                                  : "Perlu Peninjauan!"}
                              </span>
                            </div>
                          </div>

                          <div className="flex flex-col gap-1.5 items-end">
                            {!alert.acknowledged && (
                              <button
                                onClick={() => acknowledgeAlert(alert.id)}
                                className="px-3 py-1.5 text-[10px] font-bold bg-emerald-50 text-emerald-800 hover:bg-emerald-600 hover:text-white border border-emerald-300 rounded-xl shadow-2xs transition-all cursor-pointer"
                              >
                                Konfirmasi
                              </button>
                            )}
                            <button
                              onClick={() => deleteAlert(alert.id)}
                              title="Hapus catatan log alarm ini secara permanen"
                              className="px-3 py-1.5 text-[10px] font-bold bg-white text-red-600 hover:bg-red-50 border border-red-200 rounded-xl transition-all cursor-pointer"
                            >
                              Hapus
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Infographic Reference Quick Overview */}
            <div className="bg-[#1A2C1F] text-emerald-100 border border-emerald-950 rounded-4xl p-6 relative overflow-hidden shadow-md">
              {/* Textured leafy green backdrop decoration */}
              <div className="absolute right-0 bottom-0 w-32 h-32 bg-emerald-900 rounded-full opacity-40 blur-xl pointer-events-none" />

              <div className="relative z-10">
                <span className="font-mono text-[9px] tracking-widest text-emerald-400 font-bold uppercase block mb-1">
                  Info Proyek ALoRa
                </span>

                <h3 className="font-serif text-lg font-bold text-white leading-tight mb-3">
                  Acoustic Long Range (ALoRa)
                </h3>

                <p className="text-xs text-emerald-200/90 leading-relaxed space-y-3">
                  Alat pendeteksi penebangan liar bertenaga surya cerdas
                  berkecepatan 18-30 detik transmisi respon, memanfaatkan
                  mikrofon digital INMP441 + ESP32 bertenaga ML (Fast Fourier
                  Transform &amp; MFCC) disalurkan menembus vegetasi lebat hutan
                  lindung via radio LoRa SX1278 (915MHz) tanpa pulsa seluler.
                </p>

                <div className="border-t border-emerald-800/80 my-4 pt-4 text-[11px] text-emerald-300 font-mono space-y-2">
                  <div className="flex justify-between">
                    <span>Inovator:</span>
                    <span className="text-white font-semibold">
                      Fadhil Alfaruqi S.B
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Instansi:</span>
                    <span className="text-white font-semibold">
                      MAN 2 Ponorogo
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Target SDG:</span>
                    <span className="text-white font-semibold">
                      SDG 13 (Climate Action)
                    </span>
                  </div>
                </div>

                <div className="bg-emerald-900/60 rounded-2xl p-4 border border-emerald-800 text-[11px] text-emerald-200 leading-relaxed">
                  🌳 <strong>Zero Carbon Footprint:</strong> Sistem sepenuhnya
                  ditenagai baterai LiFePO4 bertenaga Solar panel surya
                  terbarukan, dilengkapi fitur <em>Deep Sleep</em> hemat daya
                  optimal.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Styled Footer */}
        <footer className="mt-20 border-t border-stone-200/50 py-10 text-center text-stone-400 text-xs font-mono w-full relative z-10 bg-white/40">
          <div className="max-w-6xl mx-auto px-4">
            <div className="font-semibold text-emerald-900 mb-1">
              ALoRa Acoustic Long Range • IoT Forest Logging Guard 2026
            </div>
            <div className="text-stone-400/80">
              Didesain dengan Cinta &amp; Tema Alam Hijau Cerah yang Segar
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
