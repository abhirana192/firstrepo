import { audioBufferToWavBlob, downloadBlob } from "./wavEncoder.js";

function fmt(sec) {
  if (!sec) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Renders the track management list and wires Mute / Solo / Layer-toggle /
 * Delete / Download controls straight to AudioEngine callbacks.
 */
export class TrackPanel {
  constructor(listEl, emptyHintEl, engine) {
    this.listEl = listEl;
    this.emptyHintEl = emptyHintEl;
    this.engine = engine;
  }

  render(tracks) {
    this.emptyHintEl.style.display = tracks.length ? "none" : "block";
    this.listEl.innerHTML = "";

    for (const track of tracks) {
      const row = document.createElement("div");
      row.className = "trackRow" + (track.enabled ? "" : " disabled");

      const swatch = document.createElement("div");
      swatch.className = "swatch";
      swatch.style.background = track.color;
      swatch.style.color = track.color;

      const name = document.createElement("div");
      name.className = "trackName";
      name.textContent = track.isReference ? `🎵 ${track.name}` : track.name;

      const dur = document.createElement("div");
      dur.className = "trackDur";
      dur.textContent = fmt(track.durationSec);

      const muteBtn = document.createElement("button");
      muteBtn.className = "trackBtn" + (track.muted ? " on-mute" : "");
      muteBtn.textContent = "M";
      muteBtn.setAttribute("aria-label", `Mute ${track.name}`);
      muteBtn.onclick = () => this.engine.setMute(track.id, !track.muted);

      const soloBtn = document.createElement("button");
      soloBtn.className = "trackBtn" + (track.soloed ? " on-solo" : "");
      soloBtn.textContent = "S";
      soloBtn.setAttribute("aria-label", `Solo ${track.name}`);
      soloBtn.onclick = () => this.engine.setSolo(track.id, !track.soloed);

      const toggle = document.createElement("button");
      toggle.className = "trackToggle" + (track.enabled ? " enabled" : "");
      toggle.setAttribute("aria-label", `Toggle ${track.name}`);
      toggle.onclick = () => this.engine.setEnabled(track.id, !track.enabled);

      // Punch-in re-records a vocal take; doesn't apply to an imported
      // reference track, so it's simply omitted from that row.
      const punchInBtn = document.createElement("button");
      if (!track.isReference) {
        punchInBtn.className = "trackPunchIn";
        punchInBtn.textContent = "⏺";
        punchInBtn.disabled = this.engine.isRecording;
        punchInBtn.setAttribute("aria-label", `Punch in and re-record ${track.name} from the current scrub position`);
        punchInBtn.onclick = () => this.engine.startPunchIn(track.id);
      }

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "trackDownload";
      downloadBtn.textContent = "⬇";
      downloadBtn.setAttribute("aria-label", `Download ${track.name}`);
      downloadBtn.onclick = () => {
        const buffer = this.engine.getTrackBuffer(track.id);
        if (!buffer) return;
        downloadBlob(audioBufferToWavBlob(buffer), `${track.name.replace(/\s+/g, "-").toLowerCase()}.wav`);
      };

      const del = document.createElement("button");
      del.className = "trackDelete";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Delete ${track.name}`);
      del.onclick = () => {
        if (confirm(`Delete ${track.name}?`)) this.engine.deleteTrack(track.id);
      };

      row.append(swatch, name, dur, muteBtn, soloBtn, toggle);
      if (!track.isReference) row.append(punchInBtn);
      row.append(downloadBtn, del);
      this.listEl.appendChild(row);
    }
  }
}
