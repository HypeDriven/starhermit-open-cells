'use strict';
/* Open Cells — the StarHermit account controls' strings (sign in, invite, the
 * signed-out toast, the leaderboard line) in the nine product locales, moved
 * from the browser build's src/gfx.js. shStrings(locale)[key]; {rank}
 * placeholder. UMD: module.exports in Node, globalThis.OCShStrings for loadClassic. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OCShStrings = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  var TABLE = {
  "en-US": {
    "signIn": "Sign in with StarHermit",
    "invite": "Invite a friend",
    "copied": "Invite link copied to the clipboard.",
    "copyFailed": "Could not copy the invite link.",
    "signedOut": "Signed out — playing locally.",
    "lbPosting": "Posting score to the leaderboard…",
    "lbRank": "Leaderboard rank: #{rank}",
    "lbPosted": "Score posted to the leaderboard.",
    "lbNotPosted": "Score not posted to the leaderboard."
  },
  "en-GB": {
    "signIn": "Sign in with StarHermit",
    "invite": "Invite a friend",
    "copied": "Invite link copied to the clipboard.",
    "copyFailed": "Couldn’t copy the invite link.",
    "signedOut": "Signed out — playing locally.",
    "lbPosting": "Posting score to the leaderboard…",
    "lbRank": "Leaderboard rank: #{rank}",
    "lbPosted": "Score posted to the leaderboard.",
    "lbNotPosted": "Score not posted to the leaderboard."
  },
  "es-419": {
    "signIn": "Iniciar sesión con StarHermit",
    "invite": "Invitar a un amigo",
    "copied": "Enlace de invitación copiado al portapapeles.",
    "copyFailed": "No se pudo copiar el enlace de invitación.",
    "signedOut": "Sesión cerrada: juegas en modo local.",
    "lbPosting": "Enviando la puntuación a la clasificación…",
    "lbRank": "Puesto en la clasificación: #{rank}",
    "lbPosted": "Puntuación enviada a la clasificación.",
    "lbNotPosted": "La puntuación no se envió a la clasificación."
  },
  "es-ES": {
    "signIn": "Iniciar sesión con StarHermit",
    "invite": "Invitar a un amigo",
    "copied": "Enlace de invitación copiado al portapapeles.",
    "copyFailed": "No se ha podido copiar el enlace de invitación.",
    "signedOut": "Sesión cerrada: juegas en local.",
    "lbPosting": "Enviando la puntuación a la clasificación…",
    "lbRank": "Puesto en la clasificación: #{rank}",
    "lbPosted": "Puntuación enviada a la clasificación.",
    "lbNotPosted": "La puntuación no se ha enviado a la clasificación."
  },
  "de-DE": {
    "signIn": "Mit StarHermit anmelden",
    "invite": "Freund einladen",
    "copied": "Einladungslink in die Zwischenablage kopiert.",
    "copyFailed": "Einladungslink konnte nicht kopiert werden.",
    "signedOut": "Abgemeldet – du spielst lokal weiter.",
    "lbPosting": "Punktzahl wird an die Bestenliste gesendet…",
    "lbRank": "Platz in der Bestenliste: #{rank}",
    "lbPosted": "Punktzahl an die Bestenliste gesendet.",
    "lbNotPosted": "Punktzahl nicht an die Bestenliste gesendet."
  },
  "fr-FR": {
    "signIn": "Se connecter avec StarHermit",
    "invite": "Inviter un ami",
    "copied": "Lien d’invitation copié dans le presse-papiers.",
    "copyFailed": "Impossible de copier le lien d’invitation.",
    "signedOut": "Déconnecté — vous jouez en local.",
    "lbPosting": "Envoi du score au classement…",
    "lbRank": "Rang au classement : #{rank}",
    "lbPosted": "Score envoyé au classement.",
    "lbNotPosted": "Score non envoyé au classement."
  },
  "fr-CA": {
    "signIn": "Se connecter avec StarHermit",
    "invite": "Inviter un ami",
    "copied": "Lien d’invitation copié dans le presse-papiers.",
    "copyFailed": "Impossible de copier le lien d’invitation.",
    "signedOut": "Déconnecté — vous jouez en local.",
    "lbPosting": "Envoi du pointage au classement…",
    "lbRank": "Rang au classement : #{rank}",
    "lbPosted": "Pointage envoyé au classement.",
    "lbNotPosted": "Pointage non envoyé au classement."
  },
  "pt-BR": {
    "signIn": "Entrar com StarHermit",
    "invite": "Convidar um amigo",
    "copied": "Link de convite copiado para a área de transferência.",
    "copyFailed": "Não foi possível copiar o link de convite.",
    "signedOut": "Sessão encerrada — jogando localmente.",
    "lbPosting": "Enviando a pontuação para o placar…",
    "lbRank": "Posição no placar: #{rank}",
    "lbPosted": "Pontuação enviada ao placar.",
    "lbNotPosted": "Pontuação não enviada ao placar."
  },
  "it-IT": {
    "signIn": "Accedi con StarHermit",
    "invite": "Invita un amico",
    "copied": "Link di invito copiato negli appunti.",
    "copyFailed": "Impossibile copiare il link di invito.",
    "signedOut": "Disconnesso: giochi in locale.",
    "lbPosting": "Invio del punteggio alla classifica…",
    "lbRank": "Posizione in classifica: #{rank}",
    "lbPosted": "Punteggio inviato alla classifica.",
    "lbNotPosted": "Punteggio non inviato alla classifica."
  }
};
  return {
    LOCALES: Object.keys(TABLE),
    shStrings: function (locale) { return TABLE[locale] || TABLE['en-US']; }
  };
});
