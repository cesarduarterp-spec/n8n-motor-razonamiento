// Detecta dispositivo, sistema, navegador y app desde la que se hizo clic (Instagram, Facebook, TikTok…).
// Los bots de vista previa (WhatsApp, Facebook, Telegram…) se marcan para no contarlos.
export function analizarUA(ua) {
  const p = re => re.test(ua);
  return {
    esBot: !ua || p(/bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|WhatsApp\/|TelegramBot|Twitterbot|Slackbot|LinkedInBot|Discordbot|Pinterest\/|Googlebot|bingbot|preview|HeadlessChrome|curl|wget|python-requests|axios|node-fetch/i),
    dispositivo:
      p(/iPad|Tablet|PlayBook|Silk/i) || (p(/Android/i) && !p(/Mobile/i)) ? 'Tablet'
      : p(/Mobi|iPhone|iPod|Android|Windows Phone/i) ? 'Móvil'
      : 'Escritorio',
    sistema:
      p(/iPhone|iPad|iPod/i) ? 'iOS'
      : p(/Android/i) ? 'Android'
      : p(/Windows/i) ? 'Windows'
      : p(/CrOS/i) ? 'ChromeOS'
      : p(/Mac OS X|Macintosh/i) ? 'macOS'
      : p(/Linux/i) ? 'Linux'
      : 'Otro',
    app_origen:
      p(/Instagram/i) ? 'Instagram'
      : p(/FBAN|FBAV|FB_IAB|FBIOS/i) ? 'Facebook'
      : p(/musical_ly|TikTok|BytedanceWebview|trill/i) ? 'TikTok'
      : p(/LinkedInApp/i) ? 'LinkedIn'
      : p(/Twitter/i) ? 'X / Twitter'
      : p(/Snapchat/i) ? 'Snapchat'
      : p(/Pinterest/i) ? 'Pinterest'
      : p(/Telegram/i) ? 'Telegram'
      : p(/GSA\//i) ? 'Google App'
      : 'Navegador',
    navegador:
      p(/Edg\//i) ? 'Edge'
      : p(/OPR\/|Opera/i) ? 'Opera'
      : p(/SamsungBrowser/i) ? 'Samsung Internet'
      : p(/Firefox|FxiOS/i) ? 'Firefox'
      : p(/Chrome|CriOS/i) ? 'Chrome'
      : p(/Safari|AppleWebKit/i) ? 'Safari'
      : 'Otro',
  };
}
