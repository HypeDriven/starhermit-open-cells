/*
 * Open Cells — graphics quality model. Pure (no three.js, no DOM): presets,
 * per-category overrides, StarHermit hardware-level Auto detection, per-preset
 * asset/effect budgets, a cost summary and the
 * Graphics panel strings. The renderer and the settings panel both read it so
 * they agree on what a setting means. Browser: window.OCGfx; Node: require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OCGfx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  var CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    reflections: ['off', 'on'],
    detail: ['plain', 'detailed'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    particles: ['off', 'low', 'high'],
    ambient: ['off', 'on']
  };

  // Each preset is a row of tiers, a render scale (multiplies the capped
  // device pixel ratio) and a device-pixel-ratio cap.
  var TABLE = {
    low:      { scale: 1,    dprCap: 1,   shadows: 'off',    reflections: 'off', detail: 'plain',    bloom: 'off', grade: 'off', antialias: 'off',  particles: 'off',  ambient: 'off' },
    balanced: { scale: 1,    dprCap: 1.5, shadows: 'low',    reflections: 'on',  detail: 'detailed', bloom: 'off', grade: 'on',  antialias: 'fxaa', particles: 'low',  ambient: 'off' },
    high:     { scale: 1,    dprCap: 2,   shadows: 'medium', reflections: 'on',  detail: 'detailed', bloom: 'on',  grade: 'on',  antialias: 'smaa', particles: 'high', ambient: 'on' },
    ultra:    { scale: 1.25, dprCap: 2,   shadows: 'high',   reflections: 'on',  detail: 'detailed', bloom: 'on',  grade: 'on',  antialias: 'msaa', particles: 'high', ambient: 'on' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  // Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker,
  // 20 = RTX 5090; src/gpu-level.js -> window.StarHermitGpu, loaded before this file): Low from 0,
  // Balanced from 4, High from 10, Ultra from 17. Phones, tablets and <= 4 GB machines are capped at 9.
  var LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
  function gpuApi() {
    if (typeof self !== 'undefined' && self.StarHermitGpu) return self.StarHermitGpu;
    return typeof globalThis !== 'undefined' ? globalThis.StarHermitGpu : null;
  }

  /**
   * Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts
   * (`system` may also be a boolean: true = phone/tablet).
   */
  function detectLevel(gpu, system) {
    var G = gpuApi();
    var sys = typeof system === 'object' && system ? system : { mobile: !!system };
    var s = Object.assign({ webgl: true, webgl2: true }, sys, { gpu: String(gpu || '') });
    if (!gpu) s.webgl = false; // no renderer string: no usable WebGL
    return G ? G.detectLevel(s) : (gpu ? LEVELS.balanced : 0);
  }

  /** The preset Auto starts from for a hardware level. */
  function presetForLevel(level) {
    var G = gpuApi();
    if (G) return G.presetForLevel(level, LEVELS);
    return PRESETS.filter(function (p) { return LEVELS[p] <= level; }).pop() || 'low';
  }

  /** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
  function detectPreset(gpu, system) {
    return presetForLevel(detectLevel(gpu, system));
  }

  /*
   * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it
   * (Low -> level 0, Balanced -> 4, High -> 10, Ultra -> 17; measured with tests/gfx-bench.mjs).
   * Cards, layout, hit areas and rules are identical on every preset — only visuals change.
   *   material  desk and card shading: lambert (Low) / standard (Balanced) / physical card faces with
   *             a clearcoat sheen when Reflections are on (High, Ultra)
   *   face      card-face texture scale over the 128×184 design grid (Surface detail Detailed; Plain = 1)
   *   texture   procedural wood texture size in px (slate and felt: half; Surface detail Detailed)
   *   surfBump  fine bump map on the slate and felt (Detailed)
   *   curve     card corner segments (rounded-rectangle outline of the card mesh)
   *   pool      lamp-pool grid of the walnut surround (vertex colours), columns × rows
   *   sparks    spark-pool size at Particles High (Low: half of it), scaled with the level
   *   motes     dust motes in the lamp light (Ambient motion On), scaled with the level
   *   bloomRes  bloom resolution as a fraction of the frame
   */
  var BUDGETS = {
    low: { material: 'lambert', face: 1, texture: 256, surfBump: false, curve: 3, pool: [24, 20], sparks: 120, motes: 30, bloomRes: 0.5 },
    balanced: { material: 'standard', face: 2, texture: 256, surfBump: false, curve: 4, pool: [36, 30], sparks: 200, motes: 40, bloomRes: 0.5 },
    high: { material: 'physical', face: 2, texture: 512, surfBump: true, curve: 8, pool: [60, 50], sparks: 400, motes: 70, bloomRes: 0.5 },
    ultra: { material: 'physical', face: 3, texture: 1024, surfBump: true, curve: 12, pool: [60, 50], sparks: 600, motes: 120, bloomRes: 1 }
  };
  var SPARK_MAX = 1200, MOTE_MAX = 240;

  /** A preset's concrete budget for a hardware level (particle counts scale <= 2x within the preset). */
  function budgetFor(preset, level) {
    var src = BUDGETS[preset] || BUDGETS.balanced;
    var b = {};
    Object.keys(src).forEach(function (k) { b[k] = src[k]; });
    var G = gpuApi(), floor = LEVELS[preset] || 0;
    var lv = Math.max(isFinite(level) && level !== null ? level : floor, floor);
    var k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
    b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
    b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
    return b;
  }

  /** Live spark-pool size for resolved settings (Particles Low: half the preset's budget). */
  function sparkCap(r) {
    return r.particles === 'high' ? r.budget.sparks : r.particles === 'low' ? Math.round(r.budget.sparks / 2) : 0;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <cat>: 'preset'|tier }
   */
  function resolve(saved, detected, level) {
    var s = saved || {};
    var auto = PRESETS.indexOf(s.preset) < 0;
    var preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    var row = TABLE[preset];
    var out = {
      preset: preset,
      auto: auto,
      renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
      dprCap: row.dprCap
    };
    out.scale = row.scale * out.renderScale;
    Object.keys(CATEGORIES).forEach(function (cat) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    });
    out.level = typeof level === 'number' && isFinite(level) ? level : LEVELS[preset];
    out.budget = budgetFor(preset, out.level);
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    // The composer runs only when an effect needs it (MSAA included, since
    // the canvas itself is created without antialiasing).
    out.post = out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
    return out;
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    return TABLE[preset] ? TABLE[preset][cat] : undefined;
  }

  /** Saved settings after choosing a preset: overrides are cleared. */
  function choosePreset(saved, preset) {
    var s = saved || {};
    return {
      preset: preset === 'auto' || PRESETS.indexOf(preset) >= 0 ? preset : 'auto',
      render_scale: s.render_scale != null ? s.render_scale : 1,
      adaptive: s.adaptive !== false,
      show_fps: !!s.show_fps
    };
  }

  /** Legacy single "quality tier" setting -> saved graphics object. */
  function fromLegacy(quality) {
    var map = { low: 'low', medium: 'balanced', high: 'high' };
    return { preset: map[quality] || 'auto', render_scale: 1, adaptive: true, show_fps: false };
  }

  // ------------------------------------------------------------------ strings

  var STRINGS = {
    'en-US': {
      sh_signIn: 'Sign in with StarHermit', sh_signInHint: 'Sync your progress and settings.', sh_invite: 'Invite a friend', sh_inviteHint: 'Copy your invite link.', sh_copied: 'Invite link copied to the clipboard.', sh_copyFailed: 'Could not copy the invite link.', sh_signedOut: 'Signed out — playing locally.', sh_lbPosting: 'Posting score to the leaderboard…', sh_lbRank: 'Leaderboard rank: #{0}', sh_lbPosted: 'Score posted to the leaderboard.', sh_lbNotPosted: 'Score not posted to the leaderboard.',
      quality: 'Quality', auto: 'Auto (detected: {0})', low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
      renderScale: 'Render scale', fromPreset: 'From preset ({0})',
      adaptive: 'Adaptive resolution', adaptiveDesc: 'Lowers the resolution while frames are slow, restores it when they recover.',
      showFps: 'Show frame rate', showFpsDesc: 'Small readout in the corner of the table.',
      postFailed: 'Post-processing is unavailable on this device; the table is drawn without it.',
      noScene: '3D view is off; these settings apply when it is on.',
      cat_shadows: 'Shadows', cat_reflections: 'Reflections', cat_detail: 'Surface detail', cat_bloom: 'Bloom',
      cat_grade: 'Color grade', cat_antialias: 'Anti-aliasing', cat_particles: 'Particles', cat_ambient: 'Ambient motion',
      t_off: 'Off', t_on: 'On', t_low: 'Low', t_medium: 'Medium', t_high: 'High', t_plain: 'Plain', t_detailed: 'Detailed',
      t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA',
      s_noShadows: 'no shadows', s_shadows: '{0}² shadows', s_reflections: 'reflections', s_bloom: 'bloom',
      s_grade: 'color grade', s_noAA: 'no anti-aliasing', unknownGpu: 'unknown GPU', level: 'Level {0}'
    },
    'en-GB': {
      sh_signIn: 'Sign in with StarHermit', sh_signInHint: 'Sync your progress and settings.', sh_invite: 'Invite a friend', sh_inviteHint: 'Copy your invite link.', sh_copied: 'Invite link copied to the clipboard.', sh_copyFailed: 'Couldn’t copy the invite link.', sh_signedOut: 'Signed out — playing locally.', sh_lbPosting: 'Posting score to the leaderboard…', sh_lbRank: 'Leaderboard rank: #{0}', sh_lbPosted: 'Score posted to the leaderboard.', sh_lbNotPosted: 'Score not posted to the leaderboard.',
      cat_grade: 'Colour grade', s_grade: 'colour grade', showFpsDesc: 'Small read-out in the corner of the table.'
    },
    'es-419': {
      sh_signIn: 'Iniciar sesión con StarHermit', sh_signInHint: 'Sincroniza tu progreso y tus ajustes.', sh_invite: 'Invitar a un amigo', sh_inviteHint: 'Copia tu enlace de invitación.', sh_copied: 'Enlace de invitación copiado al portapapeles.', sh_copyFailed: 'No se pudo copiar el enlace de invitación.', sh_signedOut: 'Sesión cerrada: juegas en modo local.', sh_lbPosting: 'Enviando la puntuación a la clasificación…', sh_lbRank: 'Puesto en la clasificación: #{0}', sh_lbPosted: 'Puntuación enviada a la clasificación.', sh_lbNotPosted: 'La puntuación no se envió a la clasificación.',
      quality: 'Calidad', auto: 'Automática (detectada: {0})', low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
      renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({0})',
      adaptive: 'Resolución adaptable', adaptiveDesc: 'Baja la resolución cuando los fotogramas van lentos y la recupera después.',
      showFps: 'Mostrar fotogramas por segundo', showFpsDesc: 'Pequeño indicador en la esquina de la mesa.',
      postFailed: 'El posprocesado no está disponible en este dispositivo; la mesa se dibuja sin él.',
      noScene: 'La vista 3D está desactivada; estos ajustes se aplican cuando esté activa.',
      cat_shadows: 'Sombras', cat_reflections: 'Reflejos', cat_detail: 'Detalle de superficies', cat_bloom: 'Resplandor',
      cat_grade: 'Corrección de color', cat_antialias: 'Suavizado de bordes', cat_particles: 'Partículas', cat_ambient: 'Movimiento ambiental',
      t_off: 'No', t_on: 'Sí', t_low: 'Bajo', t_medium: 'Medio', t_high: 'Alto', t_plain: 'Simple', t_detailed: 'Detallado',
      s_noShadows: 'sin sombras', s_shadows: 'sombras de {0}²', s_reflections: 'reflejos', s_bloom: 'resplandor',
      s_grade: 'corrección de color', s_noAA: 'sin suavizado', unknownGpu: 'GPU desconocida', level: 'Nivel {0}'
    },
    'es-ES': {
      sh_signIn: 'Iniciar sesión con StarHermit', sh_signInHint: 'Sincroniza tu progreso y tus ajustes.', sh_invite: 'Invitar a un amigo', sh_inviteHint: 'Copia tu enlace de invitación.', sh_copied: 'Enlace de invitación copiado al portapapeles.', sh_copyFailed: 'No se ha podido copiar el enlace de invitación.', sh_signedOut: 'Sesión cerrada: juegas en local.', sh_lbPosting: 'Enviando la puntuación a la clasificación…', sh_lbRank: 'Puesto en la clasificación: #{0}', sh_lbPosted: 'Puntuación enviada a la clasificación.', sh_lbNotPosted: 'La puntuación no se ha enviado a la clasificación.',
      renderScale: 'Escala de renderizado', showFps: 'Mostrar imágenes por segundo', t_off: 'Desactivado', t_on: 'Activado'
    },
    'de-DE': {
      sh_signIn: 'Mit StarHermit anmelden', sh_signInHint: 'Fortschritt und Einstellungen synchronisieren.', sh_invite: 'Freund einladen', sh_inviteHint: 'Einladungslink kopieren.', sh_copied: 'Einladungslink in die Zwischenablage kopiert.', sh_copyFailed: 'Einladungslink konnte nicht kopiert werden.', sh_signedOut: 'Abgemeldet – du spielst lokal weiter.', sh_lbPosting: 'Punktzahl wird an die Bestenliste gesendet…', sh_lbRank: 'Platz in der Bestenliste: #{0}', sh_lbPosted: 'Punktzahl an die Bestenliste gesendet.', sh_lbNotPosted: 'Punktzahl nicht an die Bestenliste gesendet.',
      quality: 'Qualität', auto: 'Automatisch (erkannt: {0})', low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
      renderScale: 'Renderskalierung', fromPreset: 'Aus Voreinstellung ({0})',
      adaptive: 'Adaptive Auflösung', adaptiveDesc: 'Senkt die Auflösung bei langsamen Bildern und stellt sie danach wieder her.',
      showFps: 'Bildrate anzeigen', showFpsDesc: 'Kleine Anzeige in der Ecke des Tisches.',
      postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; der Tisch wird ohne sie gezeichnet.',
      noScene: 'Die 3D-Ansicht ist aus; diese Einstellungen gelten, sobald sie an ist.',
      cat_shadows: 'Schatten', cat_reflections: 'Spiegelungen', cat_detail: 'Oberflächendetails', cat_bloom: 'Leuchten',
      cat_grade: 'Farbkorrektur', cat_antialias: 'Kantenglättung', cat_particles: 'Partikel', cat_ambient: 'Umgebungsbewegung',
      t_off: 'Aus', t_on: 'An', t_low: 'Niedrig', t_medium: 'Mittel', t_high: 'Hoch', t_plain: 'Schlicht', t_detailed: 'Detailliert',
      s_noShadows: 'keine Schatten', s_shadows: '{0}²-Schatten', s_reflections: 'Spiegelungen', s_bloom: 'Leuchten',
      s_grade: 'Farbkorrektur', s_noAA: 'keine Kantenglättung', unknownGpu: 'unbekannte GPU', level: 'Stufe {0}'
    },
    'fr-FR': {
      sh_signIn: 'Se connecter avec StarHermit', sh_signInHint: 'Synchronisez progression et réglages.', sh_invite: 'Inviter un ami', sh_inviteHint: 'Copier votre lien d’invitation.', sh_copied: 'Lien d’invitation copié dans le presse-papiers.', sh_copyFailed: 'Impossible de copier le lien d’invitation.', sh_signedOut: 'Déconnecté — vous jouez en local.', sh_lbPosting: 'Envoi du score au classement…', sh_lbRank: 'Rang au classement : #{0}', sh_lbPosted: 'Score envoyé au classement.', sh_lbNotPosted: 'Score non envoyé au classement.',
      quality: 'Qualité', auto: 'Auto (détectée : {0})', low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
      renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({0})',
      adaptive: 'Résolution adaptative', adaptiveDesc: 'Baisse la résolution quand les images ralentissent, puis la rétablit.',
      showFps: 'Afficher les images par seconde', showFpsDesc: 'Petit indicateur dans le coin de la table.',
      postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; la table est dessinée sans lui.',
      noScene: 'La vue 3D est désactivée ; ces réglages s’appliquent quand elle est active.',
      cat_shadows: 'Ombres', cat_reflections: 'Reflets', cat_detail: 'Détail des surfaces', cat_bloom: 'Halo lumineux',
      cat_grade: 'Étalonnage des couleurs', cat_antialias: 'Anticrénelage', cat_particles: 'Particules', cat_ambient: 'Mouvement d’ambiance',
      t_off: 'Désactivé', t_on: 'Activé', t_low: 'Bas', t_medium: 'Moyen', t_high: 'Élevé', t_plain: 'Simple', t_detailed: 'Détaillé',
      s_noShadows: 'sans ombres', s_shadows: 'ombres {0}²', s_reflections: 'reflets', s_bloom: 'halo',
      s_grade: 'étalonnage', s_noAA: 'sans anticrénelage', unknownGpu: 'GPU inconnu', level: 'Niveau {0}'
    },
    'fr-CA': {
      sh_signIn: 'Se connecter avec StarHermit', sh_signInHint: 'Synchronisez votre progression et vos paramètres.', sh_invite: 'Inviter un ami', sh_inviteHint: 'Copier votre lien d’invitation.', sh_copied: 'Lien d’invitation copié dans le presse-papiers.', sh_copyFailed: 'Impossible de copier le lien d’invitation.', sh_signedOut: 'Déconnecté — vous jouez en local.', sh_lbPosting: 'Envoi du pointage au classement…', sh_lbRank: 'Rang au classement : #{0}', sh_lbPosted: 'Pointage envoyé au classement.', sh_lbNotPosted: 'Pointage non envoyé au classement.',
      auto: 'Auto (détectée : {0})', showFps: 'Afficher la fréquence d’images', cat_antialias: 'Antialiasing', s_noAA: 'sans antialiasing'
    },
    'pt-BR': {
      sh_signIn: 'Entrar com StarHermit', sh_signInHint: 'Sincronize seu progresso e suas configurações.', sh_invite: 'Convidar um amigo', sh_inviteHint: 'Copie seu link de convite.', sh_copied: 'Link de convite copiado para a área de transferência.', sh_copyFailed: 'Não foi possível copiar o link de convite.', sh_signedOut: 'Sessão encerrada — jogando localmente.', sh_lbPosting: 'Enviando a pontuação para o placar…', sh_lbRank: 'Posição no placar: #{0}', sh_lbPosted: 'Pontuação enviada ao placar.', sh_lbNotPosted: 'Pontuação não enviada ao placar.',
      quality: 'Qualidade', auto: 'Automática (detectada: {0})', low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
      renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({0})',
      adaptive: 'Resolução adaptativa', adaptiveDesc: 'Reduz a resolução quando os quadros ficam lentos e a restaura depois.',
      showFps: 'Mostrar taxa de quadros', showFpsDesc: 'Pequeno indicador no canto da mesa.',
      postFailed: 'O pós-processamento não está disponível neste dispositivo; a mesa é desenhada sem ele.',
      noScene: 'A visão 3D está desligada; estas configurações valem quando ela estiver ligada.',
      cat_shadows: 'Sombras', cat_reflections: 'Reflexos', cat_detail: 'Detalhe das superfícies', cat_bloom: 'Brilho',
      cat_grade: 'Correção de cor', cat_antialias: 'Antisserrilhado', cat_particles: 'Partículas', cat_ambient: 'Movimento ambiente',
      t_off: 'Desligado', t_on: 'Ligado', t_low: 'Baixo', t_medium: 'Médio', t_high: 'Alto', t_plain: 'Simples', t_detailed: 'Detalhado',
      s_noShadows: 'sem sombras', s_shadows: 'sombras {0}²', s_reflections: 'reflexos', s_bloom: 'brilho',
      s_grade: 'correção de cor', s_noAA: 'sem antisserrilhado', unknownGpu: 'GPU desconhecida', level: 'Nível {0}'
    },
    'it-IT': {
      sh_signIn: 'Accedi con StarHermit', sh_signInHint: 'Sincronizza progressi e impostazioni.', sh_invite: 'Invita un amico', sh_inviteHint: 'Copia il tuo link di invito.', sh_copied: 'Link di invito copiato negli appunti.', sh_copyFailed: 'Impossibile copiare il link di invito.', sh_signedOut: 'Disconnesso: giochi in locale.', sh_lbPosting: 'Invio del punteggio alla classifica…', sh_lbRank: 'Posizione in classifica: #{0}', sh_lbPosted: 'Punteggio inviato alla classifica.', sh_lbNotPosted: 'Punteggio non inviato alla classifica.',
      quality: 'Qualità', auto: 'Automatica (rilevata: {0})', low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
      renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({0})',
      adaptive: 'Risoluzione adattiva', adaptiveDesc: 'Riduce la risoluzione quando i fotogrammi rallentano e la ripristina dopo.',
      showFps: 'Mostra frequenza fotogrammi', showFpsDesc: 'Piccolo indicatore nell’angolo del tavolo.',
      postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il tavolo viene disegnato senza.',
      noScene: 'La vista 3D è disattivata; queste impostazioni si applicano quando è attiva.',
      cat_shadows: 'Ombre', cat_reflections: 'Riflessi', cat_detail: 'Dettaglio superfici', cat_bloom: 'Bagliore',
      cat_grade: 'Correzione colore', cat_antialias: 'Antialiasing', cat_particles: 'Particelle', cat_ambient: 'Movimento ambientale',
      t_off: 'No', t_on: 'Sì', t_low: 'Basso', t_medium: 'Medio', t_high: 'Alto', t_plain: 'Semplice', t_detailed: 'Dettagliato',
      s_noShadows: 'senza ombre', s_shadows: 'ombre {0}²', s_reflections: 'riflessi', s_bloom: 'bagliore',
      s_grade: 'correzione colore', s_noAA: 'senza antialiasing', unknownGpu: 'GPU sconosciuta', level: 'Livello {0}'
    }
  };
  // Regional variants inherit from their base table.
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var LANG_DEFAULT = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

  function pickLocale(lang) {
    var l = String(lang || 'en-US');
    var exact = Object.keys(STRINGS).find(function (k) { return k.toLowerCase() === l.toLowerCase(); });
    if (exact) return exact;
    var base = l.split('-')[0].toLowerCase();
    if (base === 'es' && /-es$/i.test(l)) return 'es-ES';
    if (base === 'fr' && /-ca$/i.test(l)) return 'fr-CA';
    if (base === 'en' && /-(gb|au|nz|ie|za|in)$/i.test(l)) return 'en-GB';
    return LANG_DEFAULT[base] || 'en-US';
  }

  /** Translator for the Graphics panel: t(key, arg0). */
  function strings(lang) {
    var loc = pickLocale(lang);
    var chain = [STRINGS[loc]];
    if (PARENT[loc]) chain.push(STRINGS[PARENT[loc]]);
    chain.push(STRINGS['en-US']);
    return function (key, arg) {
      for (var i = 0; i < chain.length; i++) {
        if (chain[i] && chain[i][key] != null) return String(chain[i][key]).replace('{0}', arg == null ? '' : arg);
      }
      return key;
    };
  }

  /** One-line cost summary of the resolved tiers. */
  function describe(r, pixels, t) {
    t = t || strings('en-US');
    var parts = [
      r.shadows === 'off' ? t('s_noShadows') : t('s_shadows', SHADOW_MAP[r.shadows]),
      r.reflections === 'on' ? t('s_reflections') : null,
      r.bloom === 'on' ? t('s_bloom') : null,
      r.grade === 'on' ? t('s_grade') : null,
      r.antialias === 'off' ? t('s_noAA') : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS,
    CATEGORIES: CATEGORIES,
    SHADOW_MAP: SHADOW_MAP,
    LEVELS: LEVELS,
    BUDGETS: BUDGETS,
    SPARK_MAX: SPARK_MAX,
    MOTE_MAX: MOTE_MAX,
    detectLevel: detectLevel,
    presetForLevel: presetForLevel,
    budgetFor: budgetFor,
    sparkCap: sparkCap,
    LOCALES: Object.keys(STRINGS),
    detectPreset: detectPreset,
    resolve: resolve,
    presetTier: presetTier,
    choosePreset: choosePreset,
    fromLegacy: fromLegacy,
    describe: describe,
    pickLocale: pickLocale,
    strings: strings
  };
});
