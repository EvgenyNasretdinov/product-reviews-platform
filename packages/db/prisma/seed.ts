// Seed data for local development and demos.
//
// Re-running this script restores the seeded baseline: every write is keyed
// by a natural key (email, slug, or a composite unique constraint) and goes
// through `upsert`, and product_rating_summary is always recomputed from
// the review rows that exist at the time the seed runs rather than
// incremented. It will not fail on unique-constraint errors.
//
// It does NOT preserve changes made through the app to a row it created.
// If you approve the seeded FLAGGED review, click around, or otherwise edit
// a seeded user/product/review, re-running this script overwrites that row
// back to its baseline values. That is deliberate -- the main reason to
// re-run this seed is to reset a demo database after clicking around in
// it -- but it means this script is a reset-to-baseline, not a safe,
// change-preserving sync. Rows this script did not create are never
// touched.
import { PrismaClient, type Role, type ReviewStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'password123';

interface SeedUserSpec {
  email: string;
  displayName: string;
  role: Role;
}

// alice, bob, and mod are the three accounts the web login picker and every
// later integration test depend on. The reviewNN accounts exist only to give
// each product enough distinct authors for a believable review count -- the
// review_id/author_id unique constraint allows only one review per author
// per product, so ~30 reviews across 8 products need more than three authors.
const USERS: SeedUserSpec[] = [
  { email: 'alice@example.com', displayName: 'Alice Johnson', role: 'CUSTOMER' },
  { email: 'bob@example.com', displayName: 'Bob Martinez', role: 'CUSTOMER' },
  { email: 'mod@example.com', displayName: 'Morgan Reyes', role: 'MODERATOR' },
  { email: 'reviewer01@example.com', displayName: 'Maria Gomez', role: 'CUSTOMER' },
  { email: 'reviewer02@example.com', displayName: 'Tom Becker', role: 'CUSTOMER' },
  { email: 'reviewer03@example.com', displayName: 'Priya Nair', role: 'CUSTOMER' },
  { email: 'reviewer04@example.com', displayName: 'Chen Wei', role: 'CUSTOMER' },
  { email: 'reviewer05@example.com', displayName: 'Sofia Rossi', role: 'CUSTOMER' },
  { email: 'reviewer06@example.com', displayName: "Liam O'Connor", role: 'CUSTOMER' },
  { email: 'reviewer07@example.com', displayName: 'Aiko Tanaka', role: 'CUSTOMER' },
  { email: 'reviewer08@example.com', displayName: 'Noah Kim', role: 'CUSTOMER' },
  { email: 'reviewer09@example.com', displayName: 'Fatima Al-Sayed', role: 'CUSTOMER' },
  { email: 'reviewer10@example.com', displayName: 'Lukas Novak', role: 'CUSTOMER' },
];

interface SeedProductSpec {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
}

const PRODUCTS: SeedProductSpec[] = [
  {
    slug: 'wireless-noise-cancelling-headphones',
    name: 'Wireless Noise-Cancelling Headphones',
    description: 'Over-ear Bluetooth headphones with active noise cancellation and a 30-hour battery life.',
    priceCents: 12999,
  },
  {
    slug: 'stainless-steel-water-bottle',
    name: 'Stainless Steel Insulated Water Bottle',
    description: 'Double-walled 750ml bottle that keeps drinks cold for 24 hours or hot for 12.',
    priceCents: 2450,
  },
  {
    slug: 'ergonomic-mesh-office-chair',
    name: 'Ergonomic Mesh Office Chair',
    description: 'Breathable mesh back, adjustable lumbar support, and armrests built for long workdays.',
    priceCents: 18900,
  },
  {
    slug: 'compact-espresso-machine',
    name: 'Compact Espresso Machine',
    description: '15-bar pump espresso machine with a built-in milk frother for lattes and cappuccinos.',
    priceCents: 24900,
  },
  {
    slug: 'smart-led-desk-lamp',
    name: 'Smart LED Desk Lamp',
    description: 'Touch-controlled desk lamp with adjustable colour temperature and a USB charging port.',
    priceCents: 3999,
  },
  {
    slug: 'portable-bluetooth-speaker',
    name: 'Portable Bluetooth Speaker',
    description: 'Waterproof speaker with 12-hour playback and deep bass, built for outdoor listening.',
    priceCents: 5999,
  },
  {
    slug: 'weighted-sleep-blanket',
    name: 'Weighted Sleep Blanket',
    description: 'Glass-bead weighted blanket in a soft cotton cover, available in 7kg and 9kg.',
    priceCents: 7400,
  },
  {
    slug: 'nonstick-ceramic-cookware-set',
    name: 'Nonstick Ceramic Cookware Set',
    description: '10-piece ceramic-coated cookware set safe for induction, gas, and electric hobs.',
    priceCents: 15900,
  },
];

// Alice has purchased four of the eight products; reviews she leaves on
// these are marked as verified purchases.
const ALICE_PURCHASED_SLUGS = [PRODUCTS[0]!.slug, PRODUCTS[1]!.slug, PRODUCTS[2]!.slug, PRODUCTS[3]!.slug];

interface ReviewSpec {
  email: string;
  rating: number;
  status: ReviewStatus;
  moderationReason?: string;
}

// One entry per product. Counts are deliberately uneven (8, 6, 5, 4, 3, 2, 1,
// 1 approved reviews) so the rating histogram has visible shape rather than
// a flat distribution, and ratings within each product skew toward that
// product's overall sentiment (mostly positive, one clearly poor performer).
// One extra PENDING review sits on the first product and one extra FLAGGED
// review sits on the second, so the moderation queue is never empty.
const REVIEW_PLAN: Record<string, ReviewSpec[]> = {
  [PRODUCTS[0]!.slug]: [
    { email: 'reviewer01@example.com', rating: 5, status: 'APPROVED' },
    { email: 'reviewer02@example.com', rating: 5, status: 'APPROVED' },
    { email: 'alice@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer03@example.com', rating: 5, status: 'APPROVED' },
    { email: 'reviewer04@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer05@example.com', rating: 3, status: 'APPROVED' },
    { email: 'reviewer06@example.com', rating: 5, status: 'APPROVED' },
    { email: 'reviewer07@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer08@example.com', rating: 5, status: 'PENDING' },
  ],
  [PRODUCTS[1]!.slug]: [
    { email: 'bob@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer01@example.com', rating: 3, status: 'APPROVED' },
    { email: 'reviewer02@example.com', rating: 5, status: 'APPROVED' },
    { email: 'reviewer03@example.com', rating: 2, status: 'APPROVED' },
    { email: 'reviewer04@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer05@example.com', rating: 3, status: 'APPROVED' },
    {
      email: 'reviewer06@example.com',
      rating: 1,
      status: 'FLAGGED',
      moderationReason: 'Flagged automatically: review text contains a suspicious external link.',
    },
  ],
  [PRODUCTS[2]!.slug]: [
    { email: 'alice@example.com', rating: 5, status: 'APPROVED' },
    { email: 'reviewer01@example.com', rating: 5, status: 'APPROVED' },
    { email: 'reviewer02@example.com', rating: 5, status: 'APPROVED' },
    { email: 'reviewer03@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer04@example.com', rating: 5, status: 'APPROVED' },
  ],
  [PRODUCTS[3]!.slug]: [
    { email: 'bob@example.com', rating: 2, status: 'APPROVED' },
    { email: 'reviewer01@example.com', rating: 3, status: 'APPROVED' },
    { email: 'reviewer02@example.com', rating: 2, status: 'APPROVED' },
    { email: 'reviewer03@example.com', rating: 1, status: 'APPROVED' },
  ],
  [PRODUCTS[4]!.slug]: [
    { email: 'reviewer01@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer02@example.com', rating: 4, status: 'APPROVED' },
    { email: 'reviewer03@example.com', rating: 5, status: 'APPROVED' },
  ],
  [PRODUCTS[5]!.slug]: [
    { email: 'reviewer01@example.com', rating: 3, status: 'APPROVED' },
    { email: 'reviewer02@example.com', rating: 4, status: 'APPROVED' },
  ],
  [PRODUCTS[6]!.slug]: [{ email: 'reviewer01@example.com', rating: 5, status: 'APPROVED' }],
  [PRODUCTS[7]!.slug]: [{ email: 'reviewer01@example.com', rating: 2, status: 'APPROVED' }],
};

const TITLES: Record<number, string[]> = {
  5: ['Love it!', 'Exceeded expectations', 'Five stars'],
  4: ['Very happy', 'Solid choice', 'Would buy again'],
  3: ["It's fine", 'Does the job', 'Middle of the road'],
  2: ['Underwhelmed', 'Not what I hoped for'],
  1: ['Would not recommend', 'Broke quickly'],
};

const BODIES: Record<number, string[]> = {
  5: [
    'Absolutely love this {name}. It exceeded my expectations and I use it every day.',
    "Best purchase I've made in a while. The {name} works flawlessly and looks great too.",
  ],
  4: [
    'Really happy with the {name}, just a couple of minor niggles keep it from a perfect score.',
    'Solid {name} that does what it promises with no surprises. Recommended.',
  ],
  3: [
    'The {name} is okay but not amazing. It does the job without standing out.',
    'Average experience with the {name}. Nothing special either way.',
  ],
  2: [
    'Disappointed with the {name}. It fell short of what the listing promised.',
    'The {name} has some real flaws that bothered me during daily use.',
  ],
  1: [
    'Would not buy the {name} again. Mine stopped working within days.',
    'Poor build quality for the {name}. Not worth the price.',
  ],
};

let textVariant = 0;
function pickText(map: Record<number, string[]>, rating: number): string {
  const options = map[rating] ?? map[3]!;
  const text = options[textVariant % options.length]!;
  textVariant += 1;
  return text;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });

  const usersByEmail = new Map<string, { id: string }>();
  for (const spec of USERS) {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      create: {
        email: spec.email,
        displayName: spec.displayName,
        passwordHash,
        role: spec.role,
      },
      update: {
        displayName: spec.displayName,
        passwordHash,
        role: spec.role,
      },
    });
    usersByEmail.set(spec.email, user);
  }

  const productsBySlug = new Map<string, { id: string; name: string; slug: string }>();
  for (const spec of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { slug: spec.slug },
      create: {
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        priceCents: spec.priceCents,
        currency: 'EUR',
        imageUrl: `https://picsum.photos/seed/${spec.slug}/640/480`,
      },
      update: {
        name: spec.name,
        description: spec.description,
        priceCents: spec.priceCents,
        currency: 'EUR',
        imageUrl: `https://picsum.photos/seed/${spec.slug}/640/480`,
      },
    });
    productsBySlug.set(spec.slug, product);
  }

  const alice = usersByEmail.get('alice@example.com')!;
  for (const [purchaseIndex, slug] of ALICE_PURCHASED_SLUGS.entries()) {
    const product = productsBySlug.get(slug)!;
    await prisma.purchase.upsert({
      where: { userId_productId: { userId: alice.id, productId: product.id } },
      create: { userId: alice.id, productId: product.id, purchasedAt: daysAgo(90 - purchaseIndex * 5) },
      update: {},
    });
  }

  let reviewIndex = 0;
  for (const [slug, specs] of Object.entries(REVIEW_PLAN)) {
    const product = productsBySlug.get(slug)!;
    for (const spec of specs) {
      const author = usersByEmail.get(spec.email)!;
      const verifiedPurchase = spec.email === 'alice@example.com' && ALICE_PURCHASED_SLUGS.includes(slug);
      const createdAt = daysAgo(60 - reviewIndex * 2);
      const publishedAt = spec.status === 'APPROVED' ? createdAt : null;
      const title = pickText(TITLES, spec.rating);
      const body = pickText(BODIES, spec.rating).replace('{name}', product.name);

      await prisma.review.upsert({
        where: { productId_authorId: { productId: product.id, authorId: author.id } },
        create: {
          productId: product.id,
          authorId: author.id,
          rating: spec.rating,
          title,
          body,
          status: spec.status,
          verifiedPurchase,
          moderationReason: spec.moderationReason ?? null,
          createdAt,
          publishedAt,
        },
        update: {
          rating: spec.rating,
          title,
          body,
          status: spec.status,
          verifiedPurchase,
          moderationReason: spec.moderationReason ?? null,
          publishedAt,
        },
      });
      reviewIndex += 1;
    }
  }

  // Recompute the rating summary projection from the review rows that exist
  // right now, rather than incrementing counters -- this is what makes
  // reseeding idempotent and keeps the projection correct even if REVIEW_PLAN
  // changes between runs.
  for (const product of productsBySlug.values()) {
    const approved = await prisma.review.findMany({
      where: { productId: product.id, status: 'APPROVED' },
      select: { rating: true },
    });
    const reviewCount = approved.length;
    const ratingSum = approved.reduce((sum, r) => sum + r.rating, 0);
    const counts = [0, 0, 0, 0, 0, 0];
    for (const r of approved) {
      counts[r.rating] = (counts[r.rating] ?? 0) + 1;
    }
    const averageRating = reviewCount > 0 ? (ratingSum / reviewCount).toFixed(2) : '0.00';

    await prisma.productRatingSummary.upsert({
      where: { productId: product.id },
      create: {
        productId: product.id,
        reviewCount,
        ratingSum,
        averageRating,
        count1: counts[1] ?? 0,
        count2: counts[2] ?? 0,
        count3: counts[3] ?? 0,
        count4: counts[4] ?? 0,
        count5: counts[5] ?? 0,
      },
      update: {
        reviewCount,
        ratingSum,
        averageRating,
        count1: counts[1] ?? 0,
        count2: counts[2] ?? 0,
        count3: counts[3] ?? 0,
        count4: counts[4] ?? 0,
        count5: counts[5] ?? 0,
      },
    });
  }

  const totalReviews = Object.values(REVIEW_PLAN).reduce((sum, specs) => sum + specs.length, 0);
  console.log(
    `Seeded ${USERS.length} users, ${PRODUCTS.length} products, ${ALICE_PURCHASED_SLUGS.length} purchases, and ${totalReviews} reviews.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
