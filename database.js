const Database = require('better-sqlite3');
const path = require('path');

class PickupDatabase {
  constructor() {
    this.db = new Database(path.join(__dirname, 'pickup.db'));
    this.initializeTables();
    this.seedMockData();
  }

  initializeTables() {
    // Students table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        year INTEGER NOT NULL,
        class TEXT NOT NULL
      )
    `);

    // Pickups table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pickups (
        id TEXT PRIMARY KEY,
        student_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        year INTEGER NOT NULL,
        class TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        acknowledged_at INTEGER,
        FOREIGN KEY (student_id) REFERENCES students(id)
      )
    `);

    // Create indexes for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pickups_status ON pickups(status);
      CREATE INDEX IF NOT EXISTS idx_pickups_class ON pickups(class);
      CREATE INDEX IF NOT EXISTS idx_students_class ON students(year, class);
    `);
  }

  seedMockData() {
    // Check if data already exists
    const count = this.db.prepare('SELECT COUNT(*) as count FROM students').get();
    if (count.count > 0) {
      console.log('Database already seeded with student data');
      return;
    }

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

    const insert = this.db.prepare(
      'INSERT INTO students (name, year, class) VALUES (?, ?, ?)'
    );

    const insertMany = this.db.transaction((students) => {
      for (const student of students) {
        insert.run(student.name, student.year, student.class);
      }
    });

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

    insertMany(students);
    console.log(`Seeded ${students.length} students across 17 classes`);
  }

  // Get all students
  getAllStudents() {
    return this.db.prepare('SELECT * FROM students ORDER BY year, class, name').all();
  }

  // Get students by year and class
  getStudentsByClass(year, className) {
    return this.db.prepare(
      'SELECT * FROM students WHERE year = ? AND class = ? ORDER BY name'
    ).all(year, className);
  }

  // Get all years
  getYears() {
    return this.db.prepare('SELECT DISTINCT year FROM students ORDER BY year').all();
  }

  // Get classes for a specific year
  getClassesByYear(year) {
    return this.db.prepare(
      'SELECT DISTINCT class FROM students WHERE year = ? ORDER BY class'
    ).all(year);
  }

  // Add a new pickup to the queue
  addPickup(pickupData) {
    const insert = this.db.prepare(`
      INSERT INTO pickups (id, student_id, student_name, year, class, timestamp, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);

    return insert.run(
      pickupData.id,
      pickupData.student_id,
      pickupData.student_name,
      pickupData.year,
      pickupData.class,
      pickupData.timestamp
    );
  }

  // Get all pending pickups
  getPendingPickups() {
    return this.db.prepare(
      "SELECT * FROM pickups WHERE status = 'pending' ORDER BY timestamp"
    ).all();
  }

  // Get pending pickups for a specific class
  getPendingPickupsByClass(year, className) {
    return this.db.prepare(
      "SELECT * FROM pickups WHERE status = 'pending' AND year = ? AND class = ? ORDER BY timestamp"
    ).all(year, className);
  }

  // Acknowledge a pickup (mark as sent)
  acknowledgePickup(pickupId) {
    const update = this.db.prepare(`
      UPDATE pickups 
      SET status = 'acknowledged', acknowledged_at = ?
      WHERE id = ?
    `);

    return update.run(Date.now(), pickupId);
  }

  // Get pickup history
  getPickupHistory(limit = 100) {
    return this.db.prepare(
      'SELECT * FROM pickups ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
  }

  // Clear old acknowledged pickups (older than 24 hours)
  clearOldPickups() {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const del = this.db.prepare(
      "DELETE FROM pickups WHERE status = 'acknowledged' AND acknowledged_at < ?"
    );
    return del.run(oneDayAgo);
  }

  // Add a new student
  addStudent(name, year, className) {
    const insert = this.db.prepare(
      'INSERT INTO students (name, year, class) VALUES (?, ?, ?)'
    );
    return insert.run(name, year, className);
  }

  // Add multiple students in a batch
  addStudentsBatch(students) {
    const insert = this.db.prepare(
      'INSERT INTO students (name, year, class) VALUES (?, ?, ?)'
    );

    const insertMany = this.db.transaction((studentList) => {
      for (const student of studentList) {
        insert.run(student.name, student.year, student.class);
      }
    });

    insertMany(students);
    return students.length;
  }

  // Delete a student
  deleteStudent(id) {
    const del = this.db.prepare('DELETE FROM students WHERE id = ?');
    return del.run(id);
  }

  // Update a student
  updateStudent(id, name, year, className) {
    const update = this.db.prepare(
      'UPDATE students SET name = ?, year = ?, class = ? WHERE id = ?'
    );
    return update.run(name, year, className, id);
  }

  close() {
    this.db.close();
  }
}

module.exports = PickupDatabase;
