const { Pool } = require('pg');

class PickupDatabase {
  constructor() {
    // Use DATABASE_URL environment variable provided by Render
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    this.initializeTables();
  }

  async initializeTables() {
    const client = await this.pool.connect();
    try {
      // Students table
      await client.query(`
        CREATE TABLE IF NOT EXISTS students (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          year INTEGER NOT NULL,
          class TEXT NOT NULL
        )
      `);

      // Pickups table
      await client.query(`
        CREATE TABLE IF NOT EXISTS pickups (
          id TEXT PRIMARY KEY,
          student_id INTEGER NOT NULL,
          student_name TEXT NOT NULL,
          year INTEGER NOT NULL,
          class TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          status TEXT DEFAULT 'pending',
          acknowledged_at BIGINT,
          FOREIGN KEY (student_id) REFERENCES students(id)
        )
      `);

      // Create indexes for faster queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_pickups_status ON pickups(status);
        CREATE INDEX IF NOT EXISTS idx_pickups_class ON pickups(class);
        CREATE INDEX IF NOT EXISTS idx_students_class ON students(year, class);
      `);

      // Class merges table - for temporary class combinations
      // Dropping table first to ensure schema update since this is a breaking change
      await client.query('DROP TABLE IF EXISTS class_merges');

      await client.query(`
        CREATE TABLE IF NOT EXISTS class_merges (
          id SERIAL PRIMARY KEY,
          source_year INTEGER NOT NULL,
          source_class TEXT NOT NULL,
          host_year INTEGER NOT NULL,
          host_class TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          UNIQUE(source_year, source_class)
        )
      `);

      // Create index for class merges
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_merges_source_year ON class_merges(source_year);
        CREATE INDEX IF NOT EXISTS idx_merges_host_year ON class_merges(host_year);
      `);

      // Mock data seeding disabled - add real students via admin interface
      console.log('Database ready. Add students through the admin interface.');
    } finally {
      client.release();
    }
  }

  async seedMockData(client) {
    console.log('Seeding database with mock student data...');

    const firstNames = [
      'James', 'Emma', 'Oliver', 'Sophia', 'William', 'Ava', 'Benjamin', 'Isabella',
      'Lucas', 'Mia', 'Henry', 'Charlotte', 'Alexander', 'Amelia', 'Michael', 'Harper',
      'Daniel', 'Evelyn', 'Matthew', 'Abigail', 'Joseph', 'Emily', 'David', 'Elizabeth',
      'Samuel', 'Sofia', 'Jackson', 'Avery', 'Sebastian', 'Ella', 'Gabriel', 'Scarlett',
      'Carter', 'Grace', 'Jayden', 'Chloe', 'John', 'Victoria', 'Dylan', 'Riley',
      'Luke', 'Aria', 'Anthony', 'Lily', 'Isaac', 'Aubrey', 'Grayson', 'Zoey',
      'Jack', 'Penelope', 'Julian', 'Lillian', 'Levi', 'Addison', 'Christopher', 'Layla',
      'Joshua', 'Natalie', 'Andrew', 'Camila', 'Lincoln', 'Hannah', 'Mateo', 'Brooklyn'
    ];

    const lastNames = [
      'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
      'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas',
      'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris',
      'Clark', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright'
    ];

    const students = [];
    let nameIndex = 0;

    // Year 7-11: Blue, Green, Red (15 classes)
    for (let year = 7; year <= 11; year++) {
      for (const color of ['blue', 'green', 'red']) {
        // 15-20 students per class
        const studentsPerClass = 15 + Math.floor(Math.random() * 6);
        for (let i = 0; i < studentsPerClass; i++) {
          const firstName = firstNames[nameIndex % firstNames.length];
          const lastName = lastNames[Math.floor(nameIndex / firstNames.length) % lastNames.length];
          students.push({
            name: `${firstName} ${lastName}`,
            year: year,
            class: color
          });
          nameIndex++;
        }
      }
    }

    // Year 12: Blue, Red (2 classes)
    for (const color of ['blue', 'red']) {
      const studentsPerClass = 12 + Math.floor(Math.random() * 6);
      for (let i = 0; i < studentsPerClass; i++) {
        const firstName = firstNames[nameIndex % firstNames.length];
        const lastName = lastNames[Math.floor(nameIndex / firstNames.length) % lastNames.length];
        students.push({
          name: `${firstName} ${lastName}`,
          year: 12,
          class: color
        });
        nameIndex++;
      }
    }

    // Batch insert students
    for (const student of students) {
      await client.query(
        'INSERT INTO students (name, year, class) VALUES ($1, $2, $3)',
        [student.name, student.year, student.class]
      );
    }

    console.log(`Seeded ${students.length} students across 17 classes`);
  }

  // Get all students
  async getAllStudents() {
    const result = await this.pool.query('SELECT * FROM students ORDER BY year, class, name');
    return result.rows;
  }

  // Get students by year and class
  async getStudentsByClass(year, className) {
    const result = await this.pool.query(
      'SELECT * FROM students WHERE year = $1 AND class = $2 ORDER BY name',
      [year, className]
    );
    return result.rows;
  }

  // Get all years
  async getYears() {
    const result = await this.pool.query('SELECT DISTINCT year FROM students ORDER BY year');
    return result.rows;
  }

  // Get all students in a year (regardless of class)
  async getStudentsByYear(year) {
    const result = await this.pool.query(
      'SELECT * FROM students WHERE year = $1 ORDER BY class, name',
      [year]
    );
    return result.rows;
  }

  // Get classes for a specific year
  async getClassesByYear(year) {
    const result = await this.pool.query(
      'SELECT DISTINCT class FROM students WHERE year = $1 ORDER BY class',
      [year]
    );
    return result.rows;
  }

  // Add a new pickup to the queue
  async addPickup(pickupData) {
    const result = await this.pool.query(
      `INSERT INTO pickups (id, student_id, student_name, year, class, timestamp, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [
        pickupData.id,
        pickupData.student_id,
        pickupData.student_name,
        pickupData.year,
        pickupData.class,
        pickupData.timestamp
      ]
    );
    return result.rows[0];
  }

  // Get all pending pickups
  async getPendingPickups() {
    const result = await this.pool.query(
      "SELECT * FROM pickups WHERE status = 'pending' ORDER BY timestamp"
    );
    return result.rows;
  }

  // Get pending pickups for a specific class
  async getPendingPickupsByClass(year, className) {
    const result = await this.pool.query(
      "SELECT * FROM pickups WHERE status = 'pending' AND year = $1 AND class = $2 ORDER BY timestamp",
      [year, className]
    );
    return result.rows;
  }

  // Acknowledge a pickup (mark as sent)
  async acknowledgePickup(pickupId) {
    const result = await this.pool.query(
      `UPDATE pickups 
       SET status = 'acknowledged', acknowledged_at = $1
       WHERE id = $2
       RETURNING *`,
      [Date.now(), pickupId]
    );
    return result.rows[0];
  }

  // Get pickup history
  async getPickupHistory(limit = 100) {
    const result = await this.pool.query(
      'SELECT * FROM pickups ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  // Clear old acknowledged pickups (older than 24 hours)
  async clearOldPickups() {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const result = await this.pool.query(
      "DELETE FROM pickups WHERE status = 'acknowledged' AND acknowledged_at < $1",
      [oneDayAgo]
    );
    return result.rowCount;
  }

  // Add a new student
  async addStudent(name, year, className) {
    const result = await this.pool.query(
      'INSERT INTO students (name, year, class) VALUES ($1, $2, $3) RETURNING *',
      [name, year, className]
    );
    return result.rows[0];
  }

  // Add multiple students in a batch
  async addStudentsBatch(students) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const student of students) {
        await client.query(
          'INSERT INTO students (name, year, class) VALUES ($1, $2, $3)',
          [student.name, student.year, student.class]
        );
      }

      await client.query('COMMIT');
      return students.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Delete a student
  async deleteStudent(id) {
    // First delete any pickups associated with this student
    await this.pool.query('DELETE FROM pickups WHERE student_id = $1', [id]);

    // Then delete the student
    const result = await this.pool.query('DELETE FROM students WHERE id = $1', [id]);
    return result.rowCount;
  }

  // Update a student
  async updateStudent(id, name, year, className) {
    const result = await this.pool.query(
      'UPDATE students SET name = $1, year = $2, class = $3 WHERE id = $4 RETURNING *',
      [name, year, className, id]
    );
    return result.rows[0];
  }

  // Delete all students
  async deleteAllStudents() {
    const result = await this.pool.query('DELETE FROM students');
    return result.rowCount;
  }

  async close() {
    await this.pool.end();
  }

  // ==================== CLASS MERGE METHODS ====================

  // Create a new merge (source class → host class)
  async createMerge(sourceYear, sourceClass, hostYear, hostClass) {
    const result = await this.pool.query(
      `INSERT INTO class_merges (source_year, source_class, host_year, host_class, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [sourceYear, sourceClass, hostYear, hostClass, Date.now()]
    );
    return result.rows[0];
  }

  // Delete a merge from a specific source
  async deleteMerge(sourceYear, sourceClass) {
    const result = await this.pool.query(
      'DELETE FROM class_merges WHERE source_year = $1 AND source_class = $2 RETURNING *',
      [sourceYear, sourceClass]
    );
    return result.rows[0];
  }

  // Get all active merges
  async getActiveMerges() {
    const result = await this.pool.query(
      'SELECT * FROM class_merges ORDER BY created_at DESC'
    );
    return result.rows;
  }

  // Get merges where the source is in a specific year
  async getMergesForYear(year) {
    const result = await this.pool.query(
      'SELECT * FROM class_merges WHERE source_year = $1 ORDER BY source_class',
      [year]
    );
    return result.rows;
  }

  // Check if a class is merged as source, return host info if so
  async getHostClass(year, className) {
    const result = await this.pool.query(
      'SELECT host_year, host_class FROM class_merges WHERE source_year = $1 AND source_class = $2',
      [year, className]
    );
    return result.rows[0] || null;
  }

  // Get all source classes merged into a host class
  async getSourceClasses(year, hostClass) {
    const result = await this.pool.query(
      'SELECT source_year, source_class FROM class_merges WHERE host_year = $1 AND host_class = $2',
      [year, hostClass]
    );
    return result.rows;
  }

  // Check if a class is being used as a host in a specific year
  async isHostClass(year, className) {
    const result = await this.pool.query(
      'SELECT COUNT(*) FROM class_merges WHERE host_year = $1 AND host_class = $2',
      [year, className]
    );
    return parseInt(result.rows[0].count) > 0;
  }

  // Check if a class is already a source (merged elsewhere)
  async isSourceClass(year, className) {
    const result = await this.pool.query(
      'SELECT COUNT(*) FROM class_merges WHERE source_year = $1 AND source_class = $2',
      [year, className]
    );
    return parseInt(result.rows[0].count) > 0;
  }

  // Clear all merges (for end-of-day reset)
  async clearAllMerges() {
    const result = await this.pool.query('DELETE FROM class_merges');
    return result.rowCount;
  }

  // Get pending pickups for a display (including merged classes from any year)
  async getPendingPickupsForDisplay(year, className) {
    // Logic: Get pickups that are EITHER:
    // 1. Direct match: pickup.year = year AND pickup.class = className AND NOT merged away
    //    (Actually, if it's merged away, it shouldn't show here? But requirement says redirect. 
    //     Usually source display doesn't show it if redirected. But let's stick to "host shows it".)
    // 2. Merged match: pickup is from a source class that is merged into THIS class

    // Note: If a student is in a class that is merged AWAY, should it still show on the original display?
    // Usually "Merge" implies "Moved". So it shouldn't show on source.
    // But for simplicity/safety, we often leave it on both or just host.
    // The previous implementation showed on host. Source display behavior wasn't explicitly preventing it 
    // unless we filter it out. 
    // Let's ensure the current display (host) gets everything destined for it.

    const query = `
      SELECT p.* 
      FROM pickups p
      LEFT JOIN class_merges m ON p.year = m.source_year AND p.class = m.source_class
      WHERE 
        p.status = 'pending' 
        AND (
          -- Item is for this class directly (and not merged away? optional, but simpler to just show what's targeting here)
          (p.year = $1 AND p.class = $2) 
          OR 
          -- Item is from a source class merged into this class
          (m.host_year = $1 AND m.host_class = $2)
        )
      ORDER BY p.timestamp ASC
    `;

    const result = await this.pool.query(query, [year, className]);
    return result.rows;
  }
}

module.exports = PickupDatabase;
