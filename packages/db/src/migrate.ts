import fs from 'fs/promises';
import path from 'path';
import postgres from 'postgres';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file if running from root
let DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  try {
    // Try multiple locations for .env file
    const possiblePaths = [
      path.join(process.cwd(), '.env'),
      path.join(__dirname, '../../.env'),
      path.join(__dirname, '../../../.env'),
    ];

    for (const envPath of possiblePaths) {
      try {
        const envContent = await fs.readFile(envPath, 'utf-8');
        const lines = envContent.split('\n');
        for (const line of lines) {
          if (line.startsWith('DATABASE_URL=')) {
            DATABASE_URL = line.split('=')[1]?.trim();
            break;
          }
        }
        if (DATABASE_URL) break;
      } catch (error) {
        // Continue to next path
      }
    }
  } catch (error) {
    // Silently ignore if .env doesn't exist
  }
}

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const sql = postgres(DATABASE_URL);

async function migrate() {
  console.log('Starting database migration...');

  try {
    // Read the migration file
    const migrationsDir = path.join(__dirname, '../migrations');
    const migrationFile = path.join(migrationsDir, '0000_init.sql');
    const migrationSQL = await fs.readFile(migrationFile, 'utf-8');

    // Execute the migration
    await sql.unsafe(migrationSQL);

    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await sql.end();
  }
}

migrate().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
