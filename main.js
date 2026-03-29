const clientId = "0f9c44ae56e146fdba5d8a59baca553d";
const redirectUri = "https://calejett.github.io/Rank-your-Playlist/";

const scopes = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private"
];

// ---------------- SETTINGS ----------------

const SMALL_PLAYLIST_THRESHOLD = 80;
const BASE_RATING = 1500;
const BIG_MAX_VOTES = 2000;

// ---------------- UI ----------------

const loginButton = document.getElementById("loginButton");
const loadPlaylistsButton = document.getElementById("loadPlaylistsButton");
const exportButton = document.getElementById("exportButton");
const playlistList = document.getElementById("playlistList");
const songAEl = document.getElementById("songA");
const songBEl = document.getElementById("songB");
const rankingList = document.getElementById("rankingList");
const buttonA = document.getElementById("buttonA");
const buttonB = document.getElementById("buttonB");
const voteCounterEl = document.getElementById("voteCounter");
const coverAEl = document.getElementById("coverA");
const coverBEl = document.getElementById("coverB");
const sideTitleEl = document.getElementById("sideTitle");

// ---------------- APP STATE ----------------

let currentTracks = [];
let currentPlaylistName = "Ranked Playlist";
let songA = null;
let songB = null;

let mode = "idle"; // idle | small_insert | ranking | done
let rankingMode = "big"; // small | big

let ratings = {};
let gamesPlayed = {};
let lastSeenRound = {};
let pairCounts = {};
let voteCount = 0;
let voteBudget = 0;

let rankedTracks = [];
let insertionIndex = 0;
let pendingTrack = null;
let low = 0;
let high = 0;
let mid = 0;

// ---------------- AUTH ----------------

function clearSpotifySession() {
  localStorage.removeItem("spotify_access_token");
  localStorage.removeItem("verifier");
}

function generateRandomString(length) {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest("SHA-256", data);
}

function base64encode(input) {
  return btoa(String.fromCharCode(...new Uint8Array(input)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function redirectToSpotifyLogin() {
  if (!clientId || clientId.includes("PASTE")) {
    alert("Paste your Spotify Client ID into main.js first.");
    return;
  }

  const verifier = generateRandomString(64);
  const challenge = base64encode(await sha256(verifier));

  localStorage.setItem("verifier", verifier);

  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("response_type", "code");
  params.append("redirect_uri", redirectUri);
  params.append("scope", scopes.join(" "));
  params.append("code_challenge_method", "S256");
  params.append("code_challenge", challenge);
  params.append("show_dialog", "true");

  window.location.href =
    `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function getAccessToken(code) {
  const verifier = localStorage.getItem("verifier");

  if (!verifier) {
    alert("Missing login session. Click Log in with Spotify again.");
    return null;
  }

  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", redirectUri);
  params.append("code_verifier", verifier);

  const result = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const data = await result.json();

  if (!result.ok || !data.access_token) {
    console.error("Spotify token error:", result.status, data);
    alert(
      `Spotify login failed: ${
        data.error_description || data.error || "Unknown error"
      }`
    );
    return null;
  }

  localStorage.setItem("spotify_access_token", data.access_token);
  history.replaceState({}, document.title, redirectUri);
  return data.access_token;
}

async function getValidToken() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");

  if (code) {
    return await getAccessToken(code);
  }

  return localStorage.getItem("spotify_access_token");
}

async function fetchSpotifyJson(url, token) {
  const result = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const rawText = await result.text();
  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    data = { rawText };
  }

  return { result, data };
}

// ---------------- LAYOUT / DISPLAY HELPERS ----------------

function getTrackImage(track) {
  return track?.album?.images?.[0]?.url || "";
}

function getTrackLabel(track) {
  const songName = track?.name || "Unknown Song";
  const artistName = track?.artists?.[0]?.name || "Unknown Artist";
  return `${songName} - ${artistName}`;
}

function updateCoverImages(track1 = null, track2 = null) {
  if (coverAEl) {
    const srcA = getTrackImage(track1);
    coverAEl.src = srcA;
    coverAEl.style.visibility = srcA ? "visible" : "hidden";
  }

  if (coverBEl) {
    const srcB = getTrackImage(track2);
    coverBEl.src = srcB;
    coverBEl.style.visibility = srcB ? "visible" : "hidden";
  }
}

function showPlaylistPanel() {
  if (sideTitleEl) sideTitleEl.textContent = "Playlists";
  if (playlistList) playlistList.classList.remove("hidden");
  if (rankingList) rankingList.classList.add("hidden");
}

function showRankingPanel() {
  if (sideTitleEl) sideTitleEl.textContent = "Current Live Ranking";
  if (playlistList) playlistList.classList.add("hidden");
  if (rankingList) rankingList.classList.remove("hidden");
}

// ---------------- PLAYLISTS ----------------

async function loadPlaylists() {
  try {
    const token = await getValidToken();

    if (!token) {
      alert("Click Log in with Spotify first.");
      return;
    }

    const { result, data } = await fetchSpotifyJson(
      "https://api.spotify.com/v1/me/playlists?limit=50",
      token
    );

    playlistList.innerHTML = "";
    rankingList.innerHTML = "";
    showPlaylistPanel();
    updateCoverImages(null, null);

    if (!result.ok) {
      console.error("Playlist load error:", result.status, data);
      alert(
        `Playlist error ${result.status}: ${
          data.error?.message || data.rawText || "Unknown error"
        }`
      );
      return;
    }

    if (!data.items || data.items.length === 0) {
      playlistList.innerHTML = "<li>No playlists found.</li>";
      return;
    }

    data.items.forEach((playlist) => {
      const li = document.createElement("li");
      const total = playlist.items?.total ?? playlist.tracks?.total ?? 0;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${playlist.name} (${total} songs)`;
      button.style.width = "100%";
      button.style.textAlign = "left";
      button.style.background = "transparent";
      button.style.border = "none";
      button.style.padding = "0";
      button.style.cursor = "pointer";
      button.style.font = "inherit";

      button.addEventListener("click", () => {
        loadTracks(playlist.id, playlist.name);
      });

      li.appendChild(button);
      playlistList.appendChild(li);
    });
  } catch (error) {
    console.error("loadPlaylists error:", error);
    alert("Something went wrong loading playlists.");
  }
}

async function loadTracks(playlistId, playlistName) {
  try {
    const token = await getValidToken();

    if (!token) {
      alert("You need to log in again.");
      return;
    }

    const allItems = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&additional_types=track`;

    while (url) {
      const { result, data } = await fetchSpotifyJson(url, token);

      if (!result.ok) {
        console.error("Track load error:", result.status, data);
        alert(
          `Could not load songs from "${playlistName}". ` +
            `Spotify error ${result.status}: ${
              data.error?.message || data.rawText || "Unknown error"
            }`
        );
        return;
      }

      if (Array.isArray(data.items)) {
        allItems.push(...data.items);
      }

      url = data.next || null;
    }

    currentTracks = allItems
      .map((entry) => entry.item || entry.track)
      .filter(
        (item) =>
          item &&
          item.type === "track" &&
          item.id &&
          item.is_local !== true
      );

    if (currentTracks.length < 2) {
      alert(`"${playlistName}" does not have enough usable tracks.`);
      return;
    }

    currentPlaylistName = playlistName;

    rankingMode =
      currentTracks.length <= SMALL_PLAYLIST_THRESHOLD ? "small" : "big";

    showRankingPanel();

    alert(
      `Loaded "${playlistName}" with ${currentTracks.length} songs.\n` +
        `Using ${rankingMode === "small" ? "small" : "big"} playlist mode.`
    );

    startAutoRanking();
  } catch (error) {
    console.error("loadTracks error:", error);
    alert(`Something went wrong loading songs: ${error.message}`);
  }
}

// ---------------- DISPLAY ----------------

function resetDisplay() {
  songA = null;
  songB = null;
  songAEl.textContent = "---";
  songBEl.textContent = "---";
  rankingList.innerHTML = "";
  updateCoverImages(null, null);
  showPlaylistPanel();
  updateVoteCounter();
}

function showPair(track1, track2) {
  songA = track1;
  songB = track2;
  songAEl.textContent = `${track1.name} - ${track1.artists[0].name}`;
  songBEl.textContent = `${track2.name} - ${track2.artists[0].name}`;
  updateCoverImages(track1, track2);
  showRankingPanel();
}

function renderRankingList(trackList, showRatings = false) {
  rankingList.innerHTML = "";
  const maxToShow = Math.min(trackList.length, 100);

  for (let i = 0; i < maxToShow; i++) {
    const track = trackList[i];
    const li = document.createElement("li");

    if (i === 0) {
      li.classList.add("top-song");
    }

    const row = document.createElement("div");
    row.className = "ranking-row";

    const img = document.createElement("img");
    img.className = "ranking-cover";
    img.src = getTrackImage(track);
    img.alt = `${track?.name || "Song"} cover`;

    const text = document.createElement("div");
    text.className = "ranking-text";

    const songName = track?.name || "Unknown";
    const artist = track?.artists?.[0]?.name || "Unknown";

    if (showRatings) {
      text.innerHTML = `
        ${i + 1}. <strong>${songName}</strong> - ${artist}
        <span class="ranking-artist">(${Math.round(ratings[track.id] ?? 0)}, ${gamesPlayed[track.id] ?? 0} votes)</span>
      `;
    } else {
      text.innerHTML = `
        ${i + 1}. <strong>${songName}</strong> - ${artist}
      `;
    }

    row.appendChild(img);
    row.appendChild(text);
    li.appendChild(row);
    rankingList.appendChild(li);
  }
}

function getSortedTracksByRating() {
  return [...currentTracks].sort((a, b) => {
    const ratingDiff = ratings[b.id] - ratings[a.id];
    if (ratingDiff !== 0) return ratingDiff;
    return gamesPlayed[a.id] - gamesPlayed[b.id];
  });
}

function updateVoteCounter() {
  if (!voteCounterEl) return;

  if (mode === "small_insert") {
    const placed = rankedTracks.length + (pendingTrack ? 0 : 0);
    const remainingSongs = Math.max(currentTracks.length - placed, 0);
    voteCounterEl.textContent = `Votes left: ${remainingSongs}`;
  } else if (mode === "ranking") {
    const remaining = Math.max(voteBudget - voteCount, 0);
    voteCounterEl.textContent = `votes left: ${remaining}`;
  } else if (mode === "done") {
    voteCounterEl.textContent = "Done";
  } else {
    voteCounterEl.textContent = "---";
  }
}

// ---------------- RANKING START ----------------

function startAutoRanking() {
  voteCount = 0;

  if (rankingMode === "small") {
    startSmallInsertionRanking();
  } else {
    startBigRanking();
  }
}

// ---------------- SMALL PLAYLIST MODE ----------------

function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function startSmallInsertionRanking() {
  mode = "small_insert";

  const shuffled = shuffleArray(currentTracks);
  rankedTracks = [shuffled[0]];
  insertionIndex = 1;
  pendingTrack = null;

  currentTracks = shuffled;

  renderRankingList(rankedTracks, false);
  showRankingPanel();
  updateVoteCounter();
  showNextInsertionComparison();
}

function showNextInsertionComparison() {
  if (insertionIndex >= currentTracks.length) {
    currentTracks = rankedTracks.slice();
    finishRanking(false);
    return;
  }

  if (!pendingTrack) {
    pendingTrack = currentTracks[insertionIndex];
    low = 0;
    high = rankedTracks.length;
  }

  if (low >= high) {
    rankedTracks.splice(low, 0, pendingTrack);
    pendingTrack = null;
    insertionIndex++;
    renderRankingList(rankedTracks, false);
    updateVoteCounter();
    showNextInsertionComparison();
    return;
  }

  mid = Math.floor((low + high) / 2);

  songA = pendingTrack;
  songB = rankedTracks[mid];

  songAEl.textContent = `${songA.name} - ${songA.artists[0].name}`;
  songBEl.textContent = `${songB.name} - ${songB.artists[0].name}`;
  updateCoverImages(songA, songB);
  showRankingPanel();

  renderRankingList(rankedTracks, false);
  updateVoteCounter();
}

function handleSmallInsertionVote(choice) {
  if (!pendingTrack) return;

  voteCount++;

  if (choice === "A") {
    high = mid;
  } else {
    low = mid + 1;
  }

  updateVoteCounter();
  showNextInsertionComparison();
}

// ---------------- BIG PLAYLIST MODE ----------------

function initializeBigRankingState() {
  ratings = {};
  gamesPlayed = {};
  lastSeenRound = {};
  pairCounts = {};

  for (const track of currentTracks) {
    ratings[track.id] = BASE_RATING;
    gamesPlayed[track.id] = 0;
    lastSeenRound[track.id] = -999999;
  }
}

function startBigRanking() {
  mode = "ranking";
  initializeBigRankingState();

  voteBudget = Math.min(
    BIG_MAX_VOTES,
    Math.max(120, Math.ceil(currentTracks.length * 2))
  );

  renderRankingList(getSortedTracksByRating(), true);
  showRankingPanel();
  updateVoteCounter();
  showNextBigPair();
}

function pairKey(id1, id2) {
  return id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function getK(trackId) {
  const played = gamesPlayed[trackId];
  if (played < 5) return 48;
  if (played < 15) return 32;
  return 20;
}

function updateBigRatings(winnerId, loserId) {
  const ra = ratings[winnerId];
  const rb = ratings[loserId];

  const ea = expectedScore(ra, rb);
  const eb = expectedScore(rb, ra);

  const ka = getK(winnerId);
  const kb = getK(loserId);

  ratings[winnerId] = ra + ka * (1 - ea);
  ratings[loserId] = rb + kb * (0 - eb);

  gamesPlayed[winnerId] += 1;
  gamesPlayed[loserId] += 1;

  lastSeenRound[winnerId] = voteCount;
  lastSeenRound[loserId] = voteCount;

  const key = pairKey(winnerId, loserId);
  pairCounts[key] = (pairCounts[key] || 0) + 1;
}

function randomFrom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function buildRankMap(sorted) {
  const rankMap = {};
  for (let i = 0; i < sorted.length; i++) {
    rankMap[sorted[i].id] = i;
  }
  return rankMap;
}

function getCandidatePoolBig() {
  const sorted = getSortedTracksByRating();
  const n = sorted.length;

  const topCount = Math.max(20, Math.floor(n * 0.25));
  const midCount = Math.max(20, Math.floor(n * 0.35));

  const pool = [];

  for (let i = 0; i < n; i++) {
    const track = sorted[i];
    let copies = 1;

    if (i < topCount) copies += 4;
    else if (i < topCount + midCount) copies += 2;

    const uncertaintyBoost = Math.max(
      0,
      6 - Math.min(gamesPlayed[track.id], 6)
    );
    copies += uncertaintyBoost;

    for (let j = 0; j < copies; j++) {
      pool.push(track);
    }
  }

  return pool;
}

function scorePairBig(track1, track2, rankMap) {
  if (!track1 || !track2 || track1.id === track2.id) return -Infinity;

  const r1 = ratings[track1.id];
  const r2 = ratings[track2.id];
  const diff = Math.abs(r1 - r2);

  const g1 = gamesPlayed[track1.id];
  const g2 = gamesPlayed[track2.id];
  const uncertainty = (1 / (1 + g1)) + (1 / (1 + g2));

  const key = pairKey(track1.id, track2.id);
  const repeats = pairCounts[key] || 0;

  const recencyPenalty =
    Math.max(0, 8 - (voteCount - lastSeenRound[track1.id])) +
    Math.max(0, 8 - (voteCount - lastSeenRound[track2.id]));

  const rank1 = rankMap[track1.id];
  const rank2 = rankMap[track2.id];
  const rankGap = Math.abs(rank1 - rank2);

  const closenessScore = 1 / (1 + diff / 40);
  const rankClosenessScore = 1 / (1 + rankGap);

  const topBias =
    (1 / (1 + rank1 * 0.08)) +
    (1 / (1 + rank2 * 0.08));

  return (
    closenessScore * 5 +
    rankClosenessScore * 6 +
    uncertainty * 10 +
    topBias * 4 -
    repeats * 3 -
    recencyPenalty * 0.4
  );
}

function pickPairBig() {
  const sorted = getSortedTracksByRating();
  const rankMap = buildRankMap(sorted);
  const pool = getCandidatePoolBig();

  let bestPair = null;
  let bestScore = -Infinity;

  const tries = Math.min(300, currentTracks.length * 3);

  for (let i = 0; i < tries; i++) {
    const t1 = randomFrom(pool);
    const t2 = randomFrom(pool);

    if (!t1 || !t2 || t1.id === t2.id) continue;

    const score = scorePairBig(t1, t2, rankMap);
    if (score > bestScore) {
      bestScore = score;
      bestPair = [t1, t2];
    }
  }

  return bestPair;
}

function showNextBigPair() {
  if (voteCount >= voteBudget) {
    finishRanking(true);
    return;
  }

  const pair = pickPairBig();

  if (!pair) {
    finishRanking(true);
    return;
  }

  showPair(pair[0], pair[1]);
  renderRankingList(getSortedTracksByRating(), true);
  updateVoteCounter();
}

function handleBigVote(choice) {
  if (!songA || !songB || mode !== "ranking") return;

  const winner = choice === "A" ? songA : songB;
  const loser = choice === "A" ? songB : songA;

  voteCount++;
  updateBigRatings(winner.id, loser.id);
  renderRankingList(getSortedTracksByRating(), true);
  showNextBigPair();
}

// ---------------- EXPORT ----------------

function getFinalRankedTracks() {
  if (mode === "done") {
    return rankingMode === "small"
      ? [...currentTracks]
      : getSortedTracksByRating();
  }

  return rankingMode === "small"
    ? [...rankedTracks]
    : getSortedTracksByRating();
}

async function createSpotifyPlaylist(token, name, description, isPublic = false) {
  const createResult = await fetch(
    "https://api.spotify.com/v1/me/playlists",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        description,
        public: isPublic
      })
    }
  );

  const playlistData = await createResult.json();
  console.log("create playlist response:", createResult.status, playlistData);

  if (!createResult.ok || !playlistData.id) {
    throw new Error(
      playlistData.error?.message ||
      `Could not create Spotify playlist (${createResult.status})`
    );
  }

  return playlistData;
}

async function addTracksToSpotifyPlaylist(token, playlistId, tracks) {
  const uris = tracks.map((track) => track.uri).filter(Boolean);

  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);

    const addResult = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/items`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ uris: chunk })
      }
    );

    const addData = await addResult.json();
    console.log("add items response:", addResult.status, addData);

    if (!addResult.ok) {
      throw new Error(
        addData.error?.message ||
        `Could not add tracks to Spotify playlist (${addResult.status})`
      );
    }
  }
}

async function exportRankedPlaylist() {
  try {
    if (currentTracks.length === 0) {
      alert("Load and rank a playlist first.");
      return;
    }

    if (mode !== "done") {
      const proceed = confirm(
        "Ranking is not finished yet. Export the current order anyway?"
      );
      if (!proceed) return;
    }

    const token = await getValidToken();

    if (!token) {
      alert("You need to log in again.");
      return;
    }

    const rankedTracksToExport = getFinalRankedTracks();

    if (!rankedTracksToExport.length) {
      alert("There are no ranked songs to export.");
      return;
    }

    exportButton.disabled = true;
    exportButton.textContent = "Exporting...";

    const playlistName = `${currentPlaylistName} - Ranked`;
    const description = "Created with Playlist Ranker";

    const newPlaylist = await createSpotifyPlaylist(
      token,
      playlistName,
      description,
      false
    );

    await addTracksToSpotifyPlaylist(token, newPlaylist.id, rankedTracksToExport);

    alert(`Spotify playlist created: ${playlistName}`);
  } catch (error) {
    console.error("exportRankedPlaylist error:", error);
    alert(`Could not export playlist: ${error.message || error}`);
  } finally {
    exportButton.disabled = false;
    exportButton.textContent = "Export New List";
  }
}

// ---------------- FINISH ----------------

function finishRanking(showRatings) {
  mode = "done";

  const finalList = showRatings ? getSortedTracksByRating() : currentTracks;
  renderRankingList(finalList, showRatings);
  showRankingPanel();
  updateVoteCounter();

  if (finalList.length > 0) {
    songAEl.textContent = `#1: ${finalList[0].name} - ${finalList[0].artists[0].name}`;
    songBEl.textContent = "Ranking complete";
    updateCoverImages(finalList[0], null);
  } else {
    updateCoverImages(null, null);
  }

  songA = null;
  songB = null;
}

// ---------------- BUTTON HANDLERS ----------------

buttonA.addEventListener("click", () => {
  if (mode === "small_insert") {
    handleSmallInsertionVote("A");
  } else if (mode === "ranking") {
    handleBigVote("A");
  }
});

buttonB.addEventListener("click", () => {
  if (mode === "small_insert") {
    handleSmallInsertionVote("B");
  } else if (mode === "ranking") {
    handleBigVote("B");
  }
});

loginButton.addEventListener("click", () => {
  clearSpotifySession();
  redirectToSpotifyLogin();
});

loadPlaylistsButton.addEventListener("click", loadPlaylists);
exportButton.addEventListener("click", exportRankedPlaylist);

// ---------------- INIT ----------------

resetDisplay();
getValidToken();
