/**
 * openrouter.js — HTML/CSS Hyperframes generator
 * ─────────────────────────────────────────────────
 * Pour les images ET les vidéos, l'IA génère un HTML animé.
 *
 *  • Image  → snapshot unique du HTML
 *  • Vidéo  → N snapshots de la boucle d'animation → MP4
 *
 * L'IA ne sait pas si le résultat sera une image ou une vidéo :
 * elle produit toujours un HTML avec animations CSS/JS/SVG/Canvas.
 */

const OR_BASE    = 'https://openrouter.ai/api/v1';
const OR_TIMEOUT = 50_000; // 50s max (modèles gratuits peuvent être lents)

/**
 * Génère un HTML animé self-contained via OpenRouter.
 *
 * @param {object} p
 * @param {string} p.model     - Slug du modèle chat OpenRouter
 * @param {string} p.prompt    - Prompt utilisateur
 * @param {string} p.style     - Style optionnel (cinematic, abstract…)
 * @param {number} p.width     - Largeur viewport (px)
 * @param {number} p.height    - Hauteur viewport (px)
 * @param {number} p.duration  - Durée de la boucle en secondes
 * @param {string} p.format    - '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
 * @param {string} p.type      - 'image' | 'video' (contexte pour le prompt système)
 * @returns {Promise<string>}  - HTML brut
 */
export async function generateHyperframeHTML({ model, prompt, style = '', width, height, duration, format, type }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY manquant');

  // Contexte de rendu pour l'IA
  const renderCtx = type === 'image'
    ? `Tu génères un VISUEL STATIQUE (snapshot unique) — une composition riche et détaillée.`
    : `Tu génères une ANIMATION LOOPÉE de ${duration} secondes — mouvement fluide et continu.`;

  const systemPrompt = `Tu es Hyperframes, un moteur de création visuelle IA de niveau professionnel.
Ta tâche : générer un fichier HTML unique, self-contained, qui rend un visuel époustouflant correspondant au prompt.

RÈGLES ABSOLUES :
1. Retourne UNIQUEMENT le HTML brut. Zéro markdown, zéro explication, zéro balise de code.
2. Le viewport doit être EXACTEMENT ${width}px × ${height}px.
   → body { margin:0; padding:0; overflow:hidden; width:${width}px; height:${height}px; background:#000; }
3. ${renderCtx}
4. Si animation : durée exacte ${duration}s, loop seamless.
5. Techniques autorisées : CSS animations, CSS @keyframes, SVG SMIL, Canvas 2D API, WebGL (vanilla), requestAnimationFrame JS.
6. AUCUNE ressource externe — tout est inline (pas de CDN, pas d'URL d'images).
7. Les couleurs doivent être vives et contrastées. Fond sombre par défaut sauf si le prompt demande autre chose.
8. L'animation/composition DÉMARRE immédiatement au chargement — aucune interaction requise.
9. Qualité premium : effets de profondeur, particules, gradients animés, formes géométriques, typographie si pertinent.
10. Format d'affichage : ${format} (${width}×${height}px) — adapte la composition à cette forme.

${style ? `Style visuel demandé : ${style}` : ''}`;

  const userPrompt = type === 'video'
    ? `Crée une animation HTML loopée de ${duration} secondes : ${prompt}`
    : `Crée une composition visuelle HTML : ${prompt}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OR_TIMEOUT);

  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  process.env.APP_URL || 'https://wividai.com',
        'X-Title':       'WiVidAi Hyperframes',
      },
      body: JSON.stringify({
        model,
        max_tokens:  8192,
        temperature: type === 'image' ? 0.75 : 0.88,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${txt.slice(0, 300)}`);
    }

    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';

    if (content.length < 50) {
      throw new Error(`Réponse IA trop courte (${content.length} chars)`);
    }

    // Nettoie les éventuels blocs markdown
    return sanitizeHTML(content);

  } finally {
    clearTimeout(timer);
  }
}

/**
 * Supprime les balises markdown et retourne le HTML propre.
 */
function sanitizeHTML(raw) {
  return raw
    .replace(/^```html?\s*/i, '')
    .replace(/\s*```\s*$/,    '')
    .trim();
}
