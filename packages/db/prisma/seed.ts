import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database with sample Project...');

  const existing = await prisma.project.findFirst({
    where: { name: 'ai-dev-team-sample' }
  });

  if (existing) {
    console.log(`Sample project already exists with ID: ${existing.id}`);
    return existing;
  }

  const project = await prisma.project.create({
    data: {
      name: 'ai-dev-team-sample',
      localPath: '/Users/apple/Documents/ElteBook/Code/PROJECT/AI DEV TEAM',
      githubRepo: 'owner/ai-dev-team-sample'
    }
  });

  console.log(`Sample project created successfully: ${project.name} (${project.id})`);
  return project;
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
