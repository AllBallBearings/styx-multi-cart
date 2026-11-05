// Made-up demo pages using the element ids Styx looks for on Amazon. Products and lists are invented.
const css = `
  html, body { margin: 0; background: #fff; color: #0f1111; font: 14px/1.4 Arial, sans-serif; }
  .box { width: 300px; padding: 20px; background: #fff; box-sizing: border-box; }
  .a-offscreen { position: absolute; left: -9999px; }
  .a-button-stack { margin-bottom: 10px; }
  .a-button { display: block; border-radius: 100px; background: #ffd814; }
  .a-button-inner { display: block; position: relative; }
  .a-button-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
  .a-button-text { display: block; padding: 9px 12px; text-align: center; font-size: 14px; color: #0f1111; }
  .buy .a-button { background: #ffa41c; }
  #wishlistButtonStack { display: flex; }
  #wishlistButtonStack > span { flex: 1; }
  #wishlistButtonStack .a-button { border-radius: 0; }
  .sub { font-size: 18px; margin: 0 0 12px; }
  .stock { color: #007600; font-size: 18px; margin: 0 0 10px; }
  .price { font-size: 26px; margin: 0 0 6px; }
  .tile { width: 240px; padding: 14px; }
  .tile img { width: 100%; display: block; }
`;
const page = (body) => `<!doctype html><meta charset="utf-8"><title>Demo</title><style>${css}</style><body>${body}</body>`;

export const cart = page(`
  <div id="sc-active-cart"><div id="sc-buy-box" class="box">
    <p class="sub">Subtotal (3 items): <b>$84.97</b></p>
    <div class="a-button-stack"><span class="a-button"><span class="a-button-inner">
      <input id="sc-buy-box-ptc-button" class="a-button-input" type="submit" />
      <span class="a-button-text">Proceed to checkout</span>
    </span></span></div>
  </div></div>`);

export const product = page(`
  <div id="dp"><div class="box" id="buybox">
    <span id="productTitle" hidden>Trailhead Insulated Water Bottle, 32 oz</span>
    <p class="price"><span id="corePrice_feature_div"><span class="a-offscreen">$24.99</span></span>$24.99</p>
    <p class="stock">In Stock</p>
    <div class="a-button-stack"><span class="a-button"><span class="a-button-inner">
      <input id="add-to-cart-button" name="submit.add-to-cart" class="a-button-input" type="submit" />
      <span class="a-button-text">Add to Cart</span>
    </span></span></div>
    <div class="a-button-stack buy"><span class="a-button"><span class="a-button-inner">
      <input id="buy-now-button" class="a-button-input" type="submit" />
      <span class="a-button-text">Buy Now</span>
    </span></span></div>
    <div id="wishlistButtonStack"><span class="a-button" id="wishListMainButton"><span class="a-button-inner">
      <span class="a-button-text" id="wishListMainButton-announce">Add to List</span>
    </span></span></div>
  </div></div>`);

export const search = page(`
  <div class="s-result-item" data-asin="B0DEMO0001" data-component-type="s-search-result"><div class="tile">
    <img src="https://images.local/bottle.svg" class="s-image" alt="Trailhead Insulated Water Bottle, 32 oz" />
    <h2 class="a-size-base-plus"><span>Trailhead Insulated Water Bottle, 32 oz</span></h2>
    <p class="a-price"><span class="a-offscreen">$24.99</span>$24.99</p>
    <span class="a-button"><span class="a-button-inner">
      <button id="a-autoid-1-announce" class="a-button-text" name="submit.addToCart" type="button" aria-label="Add to cart" data-asin="B0DEMO0001">Add to cart</button>
    </span></span>
  </div></div>`);

export const list = page(`
  <div class="box" style="width:640px"><span id="profile-list-name" style="font-size:20px;font-weight:700">Birthday Cart</span></div>`);

export const bottle = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#eef3f7"/><rect x="82" y="22" width="36" height="26" rx="5" fill="#27323d"/><path d="M72 62q0-14 14-14h28q14 0 14 14v104q0 14-14 14H86q-14 0-14-14z" fill="#2e8fa8"/><rect x="72" y="96" width="56" height="30" fill="#ff9900"/></svg>`;
