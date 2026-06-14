(function () {
  const STORAGE_KEY = "musicState";
  const DEFAULT_STATE = {
    isPlaying: false,
    position: 0,
    lastUpdate: Date.now(),
    volume: 45,
    preferenceSet: false
  };

  function readState() {
    try {
      return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
    } catch (error) {
      return { ...DEFAULT_STATE };
    }
  }

  function writeState(state) {
    state.lastUpdate = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function buildPanel(state) {
    const panel = document.createElement("div");
    panel.className = "music-panel";
    panel.innerHTML = `
      <div class="music-panel-row">
        <button class="music-toggle" type="button">Music</button>
        <input class="music-slider" type="range" min="0" max="100" value="${state.volume}" aria-label="Volume musique">
        <span class="music-volume-value">${state.volume}%</span>
      </div>
    `;
    document.body.appendChild(panel);
    return {
      toggle: panel.querySelector(".music-toggle"),
      slider: panel.querySelector(".music-slider"),
      value: panel.querySelector(".music-volume-value")
    };
  }

  function buildChoice() {
    const choice = document.createElement("div");
    choice.className = "music-choice";
    choice.innerHTML = `
      <div class="music-choice-box">
        <h2 class="music-choice-title">Musique ?</h2>
        <p class="music-choice-text">Choisis comment tu veux entrer sur le site.</p>
        <div class="music-choice-actions">
          <button class="music-choice-btn" type="button" data-music-choice="on">Avec musique</button>
          <button class="music-choice-btn secondary" type="button" data-music-choice="off">Sans musique</button>
        </div>
      </div>
    `;
    document.body.appendChild(choice);
    return choice;
  }

  window.HCMusicControls = {
    init(options) {
      const config = { promptOnEntry: false, ...options };
      const iframe = document.getElementById("sc-player");
      if (!iframe || !window.SC) return;

      const widget = SC.Widget(iframe);
      const state = readState();
      if (state.isPlaying) {
        state.position += (Date.now() - state.lastUpdate) / 1000;
      }

      const controls = buildPanel(state);
      let ready = false;

      function refreshControls() {
        controls.slider.value = state.volume;
        controls.value.textContent = `${state.volume}%`;
        controls.toggle.textContent = state.isPlaying ? "Pause" : "Play";
        controls.toggle.classList.toggle("is-muted", !state.isPlaying);
      }

      function applyVolume() {
        widget.setVolume(Number(state.volume));
      }

      function playMusic() {
        state.isPlaying = true;
        state.preferenceSet = true;
        if (ready) {
          applyVolume();
          widget.play();
        }
        writeState(state);
        refreshControls();
      }

      function pauseMusic() {
        state.isPlaying = false;
        state.preferenceSet = true;
        if (ready) {
          widget.pause();
        }
        writeState(state);
        refreshControls();
      }

      controls.toggle.addEventListener("click", () => {
        if (state.isPlaying) {
          pauseMusic();
        } else {
          playMusic();
        }
      });

      controls.slider.addEventListener("input", () => {
        state.volume = Number(controls.slider.value);
        applyVolume();
        writeState(state);
        refreshControls();
      });

      widget.bind(SC.Widget.Events.READY, function () {
        ready = true;
        applyVolume();
        if (state.isPlaying) {
          widget.seekTo(state.position * 1000);
          widget.play();
        }
        refreshControls();

        setInterval(() => {
          widget.getPosition(function (pos) {
            state.position = pos / 1000;
            writeState(state);
          });
        }, 1000);
      });

      if (config.promptOnEntry && !state.preferenceSet) {
        const choice = buildChoice();
        choice.addEventListener("click", (event) => {
          const button = event.target.closest("[data-music-choice]");
          if (!button) return;
          choice.classList.add("hidden");
          setTimeout(() => choice.remove(), 350);
          if (button.dataset.musicChoice === "on") {
            playMusic();
          } else {
            pauseMusic();
          }
        });
      }

      window.addEventListener("beforeunload", () => {
        if (!ready) return;
        widget.getPosition(function (pos) {
          state.position = pos / 1000;
          writeState(state);
        });
      });
    }
  };
})();
