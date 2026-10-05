package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

// DB wraps the sql.DB connection pool
type DB struct {
	*sql.DB
}

// New creates a new PostgreSQL database connection with retry logic
func New(host, port, user, password, dbname string) (*DB, error) {
	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		host, port, user, password, dbname)
	return NewFromDSN(dsn, fmt.Sprintf("%s:%s/%s", host, port, dbname))
}

// NewFromURL creates a connection using a PostgreSQL URL (e.g. from Neon/Render)
func NewFromURL(databaseURL string) (*DB, error) {
	return NewFromDSN(databaseURL, "DATABASE_URL")
}

// NewFromDSN connects to PostgreSQL with retries and connection pool settings
func NewFromDSN(dsn, label string) (*DB, error) {
	var db *sql.DB
	var err error

	// Retry connection — containers/remote servers may still be establishing
	for i := 0; i < 30; i++ {
		db, err = sql.Open("postgres", dsn)
		if err == nil {
			if pingErr := db.Ping(); pingErr == nil {
				break
			}
		}
		log.Printf("Waiting for database (%s)... attempt %d/30", label, i+1)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to connect to database (%s) after retries: %w", label, err)
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	log.Printf("Database connection established: %s", label)
	return &DB{db}, nil
}

// RunMigrations applies all pending SQL migrations from the migrations directory
func (db *DB) RunMigrations(migrationsDir string) error {
	// Create migrations tracking table
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	// Find all .up.sql files
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	var migrations []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".up.sql") {
			migrations = append(migrations, e.Name())
		}
	}
	sort.Strings(migrations)

	for _, name := range migrations {
		// Extract version number from filename (e.g., "001_init_schema.up.sql" -> 1)
		var version int
		fmt.Sscanf(name, "%d", &version)

		// Check if already applied
		var exists bool
		err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)", version).Scan(&exists)
		if err != nil {
			return fmt.Errorf("check migration %d: %w", version, err)
		}
		if exists {
			continue
		}

		// Read and execute migration
		content, err := os.ReadFile(filepath.Join(migrationsDir, name))
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}

		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("begin transaction for migration %d: %w", version, err)
		}

		if _, err := tx.Exec(string(content)); err != nil {
			tx.Rollback()
			return fmt.Errorf("execute migration %s: %w", name, err)
		}

		if _, err := tx.Exec("INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %d: %w", version, err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", version, err)
		}

		log.Printf("Applied migration: %s", name)
	}

	log.Println("Database migrations complete")
	return nil
}
