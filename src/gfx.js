/*
 * Open Cells — graphics quality model. Pure (no three.js, no DOM): presets,
 * per-category overrides, GPU-based Auto detection, a cost summary and the
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

  /** Best preset for this GPU, from the unmasked renderer string. */
  function detectPreset(gpu, touch) {
    var g = String(gpu || '').toLowerCase();
    var p;
    if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(g)) p = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|apple m\d/.test(g)) p = 'high';
    else p = 'balanced';
    // Phones and tablets: cap Auto at Balanced (heat and battery).
    if (touch && (p === 'high' || p === 'ultra')) p = 'balanced';
    return p;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <cat>: 'preset'|tier }
   */
  function resolve(saved, detected) {
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
      sh_signIn: 'Sign in with StarHermit', sh_signInHint: 'Sync your progress and settings.', sh_invite: 'Invite a friend', sh_inviteHint: 'Copy your invite link.', sh_copied: 'Invite link copied to the clipboard.', sh_copyFailed: 'Could not copy the invite link.', sh_signedOut: 'Signed out — playing locally.',
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
      s_grade: 'color grade', s_noAA: 'no anti-aliasing', unknownGpu: 'unknown GPU'
    },
    'en-GB': {
      sh_signIn: 'Sign in with StarHermit', sh_signInHint: 'Sync your progress and settings.', sh_invite: 'Invite a friend', sh_inviteHint: 'Copy your invite link.', sh_copied: 'Invite link copied to the clipboard.', sh_copyFailed: 'Couldn’t copy the invite link.', sh_signedOut: 'Signed out — playing locally.',
      cat_grade: 'Colour grade', s_grade: 'colour grade', showFpsDesc: 'Small read-out in the corner of the table.'
    },
    'es-419': {
      sh_signIn: 'Iniciar sesión con StarHermit', sh_signInHint: 'Sincroniza tu progreso y tus ajustes.', sh_invite: 'Invitar a un amigo', sh_inviteHint: 'Copia tu enlace de invitación.', sh_copied: 'Enlace de invitación copiado al portapapeles.', sh_copyFailed: 'No se pudo copiar el enlace de invitación.', sh_signedOut: 'Sesión cerrada: juegas en modo local.',
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
      s_grade: 'corrección de color', s_noAA: 'sin suavizado', unknownGpu: 'GPU desconocida'
    },
    'es-ES': {
      sh_signIn: 'Iniciar sesión con StarHermit', sh_signInHint: 'Sincroniza tu progreso y tus ajustes.', sh_invite: 'Invitar a un amigo', sh_inviteHint: 'Copia tu enlace de invitación.', sh_copied: 'Enlace de invitación copiado al portapapeles.', sh_copyFailed: 'No se ha podido copiar el enlace de invitación.', sh_signedOut: 'Sesión cerrada: juegas en local.',
      renderScale: 'Escala de renderizado', showFps: 'Mostrar imágenes por segundo', t_off: 'Desactivado', t_on: 'Activado'
    },
    'de-DE': {
      sh_signIn: 'Mit StarHermit anmelden', sh_signInHint: 'Fortschritt und Einstellungen synchronisieren.', sh_invite: 'Freund einladen', sh_inviteHint: 'Einladungslink kopieren.', sh_copied: 'Einladungslink in die Zwischenablage kopiert.', sh_copyFailed: 'Einladungslink konnte nicht kopiert werden.', sh_signedOut: 'Abgemeldet – du spielst lokal weiter.',
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
      s_grade: 'Farbkorrektur', s_noAA: 'keine Kantenglättung', unknownGpu: 'unbekannte GPU'
    },
    'fr-FR': {
      sh_signIn: 'Se connecter avec StarHermit', sh_signInHint: 'Synchronisez progression et réglages.', sh_invite: 'Inviter un ami', sh_inviteHint: 'Copier votre lien d’invitation.', sh_copied: 'Lien d’invitation copié dans le presse-papiers.', sh_copyFailed: 'Impossible de copier le lien d’invitation.', sh_signedOut: 'Déconnecté — vous jouez en local.',
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
      s_grade: 'étalonnage', s_noAA: 'sans anticrénelage', unknownGpu: 'GPU inconnu'
    },
    'fr-CA': {
      sh_signIn: 'Se connecter avec StarHermit', sh_signInHint: 'Synchronisez votre progression et vos paramètres.', sh_invite: 'Inviter un ami', sh_inviteHint: 'Copier votre lien d’invitation.', sh_copied: 'Lien d’invitation copié dans le presse-papiers.', sh_copyFailed: 'Impossible de copier le lien d’invitation.', sh_signedOut: 'Déconnecté — vous jouez en local.',
      auto: 'Auto (détectée : {0})', showFps: 'Afficher la fréquence d’images', cat_antialias: 'Antialiasing', s_noAA: 'sans antialiasing'
    },
    'pt-BR': {
      sh_signIn: 'Entrar com StarHermit', sh_signInHint: 'Sincronize seu progresso e suas configurações.', sh_invite: 'Convidar um amigo', sh_inviteHint: 'Copie seu link de convite.', sh_copied: 'Link de convite copiado para a área de transferência.', sh_copyFailed: 'Não foi possível copiar o link de convite.', sh_signedOut: 'Sessão encerrada — jogando localmente.',
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
      s_grade: 'correção de cor', s_noAA: 'sem antisserrilhado', unknownGpu: 'GPU desconhecida'
    },
    'it-IT': {
      sh_signIn: 'Accedi con StarHermit', sh_signInHint: 'Sincronizza progressi e impostazioni.', sh_invite: 'Invita un amico', sh_inviteHint: 'Copia il tuo link di invito.', sh_copied: 'Link di invito copiato negli appunti.', sh_copyFailed: 'Impossibile copiare il link di invito.', sh_signedOut: 'Disconnesso: giochi in locale.',
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
      s_grade: 'correzione colore', s_noAA: 'senza antialiasing', unknownGpu: 'GPU sconosciuta'
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
