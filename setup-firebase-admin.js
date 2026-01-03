const { db } = require('./backend/firebase/firebaseConfig');
const { collection, doc, setDoc, getDocs } = require('firebase/firestore');

/**
 * Setup script to initialize Firebase collections and resolve permissions issues
 */
async function setupFirebaseAdmin() {
    try {
        console.log('Setting up Firebase admin collection...');
        
        // Check if admins collection exists and has data
        const adminCollection = collection(db, 'admins');
        const snapshot = await getDocs(adminCollection);
        
        if (snapshot.empty) {
            console.log('Admins collection is empty. Creating initial admin entry...');
            
            // Create an initial admin entry
            const adminEmail = 'prathmeshojha2307@gmail.com';
            
            await setDoc(doc(adminCollection, 'admin_initial'), {
                email: adminEmail,
                userId: 'admin_initial',
                addedAt: new Date().toISOString(),
                role: 'super_admin'
            });
            
            console.log(`Created admin entry for: ${adminEmail}`);
        } else {
            console.log(`Found ${snapshot.size} existing admin entries`);
            snapshot.forEach(doc => {
                console.log(`Admin: ${doc.data().email}`);
            });
        }
        
        console.log('Firebase admin setup completed successfully!');
        
    } catch (error) {
        console.error('Error setting up Firebase admin:', error);
        
        if (error.code === 'permission-denied') {
            console.log('\n=== FIREBASE PERMISSIONS ISSUE DETECTED ===');
            console.log('To fix this issue, you need to:');
            console.log('1. Go to Firebase Console (https://console.firebase.google.com)');
            console.log('2. Select your project');
            console.log('3. Go to Firestore Database > Rules');
            console.log('4. Replace the rules with the content from firestore.rules file');
            console.log('5. Update the admin email in firestore.rules');
            console.log('6. Deploy the rules');
            console.log('\nAlternatively, you can run this script after setting up proper Firebase rules.');
        }
    }
}

// Run the setup if this file is executed directly
if (require.main === module) {
    setupFirebaseAdmin()
        .then(() => {
            console.log('Setup completed!');
            process.exit(0);
        })
        .catch(error => {
            console.error('Setup failed:', error);
            process.exit(1);
        });
}

module.exports = { setupFirebaseAdmin }; 