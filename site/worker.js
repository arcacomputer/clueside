const CANONICAL_HOST = 'clueside.com';
const WWW_HOST = `www.${CANONICAL_HOST}`;

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const isApex = url.hostname === CANONICAL_HOST;
    const isWww = url.hostname === WWW_HOST;

    if ((isApex || isWww) && (isWww || url.protocol !== 'https:')) {
      url.protocol = 'https:';
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url, 308);
    }

    return env.ASSETS.fetch(request);
  },
};
