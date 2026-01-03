const {auth, db} = require('./firebaseConfig');
const {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    confirmPasswordReset,
    deleteUser,
    EmailAuthProvider,
    reauthenticateWithCredential
} = require('firebase/auth');
const {doc, setDoc, updateDoc, collection, query, where, getDocs, limit, deleteDoc} = require('firebase/firestore');
const dotenv = require('dotenv');

dotenv.config();

let ADMIN_EMAILS = [];
let adminEmailsLoaded = false; // Add a flag to track if emails have been loaded

/**
 * Create a readable document ID from a username
 * @param {string} username - The username to convert
 * @returns {string} - A readable document ID
 */
const createReadableId = (username) => {
    // Remove special characters and spaces
    const sanitized = username.replace(/[^a-zA-Z0-9]/g, '');
    // Add timestamp to ensure uniqueness
    const timestamp = new Date().getTime();
    return `${sanitized}_${timestamp}`;
};

// Load admin emails from Firestore
async function loadAdminEmails() {
    if (adminEmailsLoaded) return ADMIN_EMAILS; // Skip if already loaded

    try {
        const adminCollection = collection(db, 'admins');
        const snapshot = await getDocs(adminCollection);
        ADMIN_EMAILS = snapshot.docs.map(doc => doc.data().email);
        adminEmailsLoaded = true; // Set the flag to true after loading
        console.log(`Loaded ${ADMIN_EMAILS.length} admin emails from Firestore`);
        return ADMIN_EMAILS;
    } catch (error) {
        console.error('Error loading admin emails:', error);
        
        // Fallback: If we can't access the admins collection, use a default admin email
        // This prevents the app from crashing and allows basic functionality
        if (error.code === 'permission-denied') {
            console.log('Firebase permissions issue detected. Using fallback admin configuration.');
            // You can add default admin emails here if needed
            ADMIN_EMAILS = [];
            adminEmailsLoaded = true;
            return ADMIN_EMAILS;
        }
        
        return [];
    }
}

/**
 * Register a new user with Firebase Authentication and store additional data in the Firestore
 */
const createUser = async (userData) => {
    try {
        // Create an auth user
        const userCredential = await createUserWithEmailAndPassword(
            auth,
            userData.email,
            userData.password
        );

        // Determine if the user is an admin
        const isAdmin = ADMIN_EMAILS.includes(userData.email);

        // Create a readable document ID from username or email
        const username = userData.username || userData.email.split('@')[0];
        const readableId = createReadableId(username);

        // Check if there are any references to this email in existing documents
        // that might have been left over from a previous deletion
        const usersRef = collection(db, 'users');
        const q = query(usersRef, where('email', '==', userData.email), limit(1));
        const existingUserSnapshot = await getDocs(q);

        // If there's an existing document with this email, delete it to avoid conflicts
        if (!existingUserSnapshot.empty) {
            const oldDocId = existingUserSnapshot.docs[0].id;
            await deleteDoc(doc(db, 'users', oldDocId));
            console.log(`Deleted existing document for email ${userData.email} with ID ${oldDocId}`);
        }

        // Store user data in Firestore using the readable ID
        await setDoc(doc(db, 'users', readableId), {
            firstName: userData.firstName,
            lastName: userData.lastName,
            email: userData.email,
            username: userData.username || '',
            phoneNumber: userData.phoneNumber || '',
            profilePicture: '/assets/profile/default-avatar.jpg',
            favorites: [],
            preferences: {theme: 'light', audioQuality: 'auto'},
            isAdmin: isAdmin,
            authUid: userCredential.user.uid, // Store the auth UID for reference
            createdAt: new Date().toISOString()
            // Do not store password in Firestore as Firebase Auth handles this
        });

        // If the user is admin, add them to admins' collection with readable ID
        if (isAdmin) {
            const adminReadableId = `admin_${readableId}`;
            await setDoc(doc(db, 'admins', adminReadableId), {
                email: userData.email,
                userId: readableId,
                addedAt: new Date().toISOString()
            });
        }

        return {
            ...userCredential.user,
            readableId
        };
    } catch (error) {
        // Translate Firebase error codes to match your existing API response format
        if (error.code === 'auth/email-already-in-use') {
            const customError = new Error('Email already exists.');
            customError.code = 'auth/email-already-exists';
            throw customError;
        }
        throw error;
    }
};

/**
 * Log in a user with Firebase Authentication
 */
const loginUser = async (email, password) => {
    console.log(`Login attempt for email: ${email}`);

    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    console.log(`Authentication successful for ${email}`);

    // Always ensure the primary admin email is in ADMIN_EMAILS
    const isPrimaryAdmin = email === 'prathmeshojha2307@gmail.com';
    if (isPrimaryAdmin && !ADMIN_EMAILS.includes(email)) {
        ADMIN_EMAILS.push(email);
        console.log(`Added primary admin email to ADMIN_EMAILS list`);
    }

    // Find user document by email query
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('email', '==', email), limit(1));
    const userSnapshot = await getDocs(q);

    if (userSnapshot.empty) {
        // Create a user document if it doesn't exist
        console.log(`User document not found for ${email}. Creating one now.`);

        // Determine if the user should be an admin - force true for primary admin
        const isUserInAdminList = isPrimaryAdmin || ADMIN_EMAILS.includes(email);

        // Create readable ID for the new user
        const username = email.split('@')[0];
        const readableId = createReadableId(username);

        // Create a basic user profile
        const userData = {
            firstName: username,
            lastName: '',
            email: email,
            username: username,
            phoneNumber: '',
            profilePicture: '/assets/profile/default-avatar.jpg',
            favorites: [],
            preferences: {theme: 'light', audioQuality: 'auto'},
            isAdmin: isUserInAdminList,
            authUid: userCredential.user.uid,
            createdAt: new Date().toISOString()
        };

        // Save to Firestore with readable ID
        await setDoc(doc(db, 'users', readableId), userData);
        console.log(`Created user document with isAdmin=${isUserInAdminList}`);

        // If admin, also add to admins' collection with readable ID
        if (isUserInAdminList) {
            const adminReadableId = `admin_${readableId}`;
            await setDoc(doc(db, 'admins', adminReadableId), {
                email: email,
                userId: readableId,
                addedAt: new Date().toISOString()
            });
            console.log(`Added user to admins collection`);
        }

        return {
            uid: userCredential.user.uid,
            readableId: readableId,
            email: userCredential.user.email,
            firstName: userData.firstName,
            lastName: userData.lastName,
            username: userData.username,
            phoneNumber: userData.phoneNumber,
            profilePicture: userData.profilePicture,
            isAdmin: isUserInAdminList
        };
    }

    const userDoc = userSnapshot.docs[0];
    const userData = userDoc.data();
    const readableId = userDoc.id;
    console.log(`Loaded user document with isAdmin=${userData.isAdmin}`);

    // For the primary admin, always ensure admin status is true
    if (isPrimaryAdmin) {
        console.log(`Primary admin account detected, ensuring admin privileges`);

        if (!userData.isAdmin) {
            await updateDoc(doc(db, 'users', readableId), {
                isAdmin: true
            });
            userData.isAdmin = true;
            console.log(`Updated user document isAdmin to true`);
        }

        // Ensure in admins' collection with readable ID
        const adminReadableId = `admin_${readableId}`;
        await setDoc(doc(db, 'admins', adminReadableId), {
            email: email,
            userId: readableId,
            addedAt: new Date().toISOString()
        });

        return {
            uid: userCredential.user.uid,
            readableId: readableId,
            email: userCredential.user.email,
            firstName: userData.firstName,
            lastName: userData.lastName,
            username: userData.username,
            phoneNumber: userData.phoneNumber,
            profilePicture: userData.profilePicture,
            isAdmin: true
        };
    }

    // For other users, check admin status as normal
    const isAdmin = await isUserAdmin(email);

    // If the user is admin but not marked as admin in DB, update their record
    if (isAdmin && !userData.isAdmin) {
        await updateDoc(doc(db, 'users', readableId), {
            isAdmin: true
        });
        userData.isAdmin = true;
        console.log(`Updated user document isAdmin to true`);
    }

    return {
        uid: userCredential.user.uid,
        readableId: readableId,
        email: userCredential.user.email,
        firstName: userData.firstName,
        lastName: userData.lastName,
        username: userData.username,
        phoneNumber: userData.phoneNumber,
        profilePicture: userData.profilePicture,
        isAdmin: isAdmin
    };
};

/**
 * Send password reset email using Firebase Auth
 */
const forgotPassword = async (email) => {
    try {
        // Get the action code settings
        const actionCodeSettings = {
            // URL you want to redirect back to after password reset.
            // Must include oobCode in the URL it redirects to
            url: `${process.env.APP_URL || 'http://localhost:3000'}/reset-password`,
            // Pass the oobCode to the reset page via the URL
            handleCodeInApp: true
        };

        await sendPasswordResetEmail(auth, email, actionCodeSettings);
        return true;
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            throw new Error('Email not associated with any account.');
        }
        throw error;
    }
};

/**
 * Reset password with a token
 */
const resetPassword = async (token, newPassword) => {
    try {
        // Confirm the password reset if the code is valid
        await confirmPasswordReset(auth, token, newPassword);

        return true;
    } catch (error) {
        if (error.code === 'auth/invalid-action-code' ||
            error.code === 'auth/expired-action-code') {
            throw new Error('Invalid or expired token.');
        }
        throw error;
    }
};

/**
 * Check if a user is an admin
 */
const isUserAdmin = async (email) => {
    console.log(`Checking admin status for email: ${email}`);

    // Special case for primary admin
    if (email === 'prathmeshojha2307@gmail.com') {
        console.log('Primary admin email detected. Admin access granted.');

        // Ensure in ADMIN_EMAILS
        if (!ADMIN_EMAILS.includes(email)) {
            ADMIN_EMAILS.push(email);
        }

        return true;
    }

    // First, check against the in-memory admin list for faster response
    if (ADMIN_EMAILS.includes(email)) {
        console.log(`- Found in ADMIN_EMAILS list. Email is admin.`);
        return true;
    }

    // Then check in the admin's collection
    try {
        const adminsRef = collection(db, 'admins');
        const q = query(adminsRef, where('email', '==', email), limit(1));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
            // Add to the in-memory cache for future checks
            if (!ADMIN_EMAILS.includes(email)) {
                ADMIN_EMAILS.push(email);
                console.log(`- Found in admins collection. Added to ADMIN_EMAILS. Email is admin.`);
            } else {
                console.log(`- Found in admins collection. Email is admin.`);
            }
            return true;
        } else {
            console.log(`- Not found in admins collection.`);
        }
    } catch (error) {
        console.error('Error checking admin status in admins collection:', error);
    }

    // Fallback: check isAdmin flag in users' collection
    try {
        const usersRef = collection(db, 'users');
        const q = query(usersRef, where('email', '==', email), where('isAdmin', '==', true), limit(1));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
            // If we find an admin user, add them to the admin's collection for future checks
            try {
                const userDoc = snapshot.docs[0];
                const readableId = userDoc.id;
                const adminReadableId = `admin_${readableId}`;

                await setDoc(doc(db, 'admins', adminReadableId), {
                    email: email,
                    userId: readableId,
                    addedAt: new Date().toISOString()
                });

                // Add to in-memory cache
                if (!ADMIN_EMAILS.includes(email)) {
                    ADMIN_EMAILS.push(email);
                }
                console.log(`- Found in users collection with isAdmin=true. Added to admins collection. Email is admin.`);
                return true;
            } catch (error) {
                console.error('Error adding admin to admins collection:', error);
                // Even if we couldn't add to admins' collection, the user is still an admin
                console.log(`- Found in users collection with isAdmin=true. Email is admin.`);
                return true;
            }
        }

        console.log(`- Not found in users collection with isAdmin=true. Email is NOT admin.`);
        return false;
    } catch (error) {
        console.error('Error checking admin status in users collection:', error);
        return false;
    }
};

/**
 * Promote a user to admin
 */
const promoteUserToAdmin = async (userEmail, adminEmail) => {
    // Verify that the requestor is an admin
    const isAdmin = await isUserAdmin(adminEmail);
    if (!isAdmin) {
        throw new Error('Unauthorized: Only admins can promote users');
    }

    // Find the user to promote
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('email', '==', userEmail), limit(1));
    const userSnapshot = await getDocs(q);

    if (userSnapshot.empty) {
        throw new Error('User not found');
    }

    const userDoc = userSnapshot.docs[0];
    const readableId = userDoc.id;

    // Update the user to an admin in users' collection
    await updateDoc(doc(db, 'users', readableId), {
        isAdmin: true
    });

    // Add to admins' collection with readable ID
    const adminReadableId = `admin_${readableId}`;
    await setDoc(doc(db, 'admins', adminReadableId), {
        email: userEmail,
        userId: readableId,
        addedAt: new Date().toISOString(),
        promotedBy: adminEmail
    });

    // Add to the admin emails array if not already there
    if (!ADMIN_EMAILS.includes(userEmail)) {
        ADMIN_EMAILS.push(userEmail);
    }

    return {message: `User ${userEmail} has been promoted to admin`};
};

/**
 * Delete a user account
 */
const deleteUserAccount = async (email, password) => {
    return Promise.resolve()
        .then(() => {
            const currentUser = auth.currentUser;
            if (!currentUser) {
                throw new Error('You must be logged in to delete your account');
            }
            return currentUser;
        })
        .then((currentUser) => {
            const credential = EmailAuthProvider.credential(email, password);
            return reauthenticateWithCredential(currentUser, credential)
                .then(() => currentUser);
        })
        .then((currentUser) => {
            const usersRef = collection(db, 'users');
            const q = query(usersRef, where('email', '==', email), limit(1));
            return getDocs(q)
                .then(userSnapshot => {
                    if (userSnapshot.empty) {
                        throw new Error('User not found in database');
                    }
                    return {
                        currentUser,
                        userDoc: userSnapshot.docs[0],
                        userId: userSnapshot.docs[0].id
                    };
                });
        })
        .then(({currentUser, userId}) => {
            return deleteDoc(doc(db, 'users', userId))
                .then(() => ({currentUser, userId}));
        })
        .then(({currentUser, userId}) => {
            if (ADMIN_EMAILS.includes(email)) {
                const adminReadableId = `admin_${userId}`;
                return deleteDoc(doc(db, 'admins', adminReadableId))
                    .then(() => {
                        const emailIndex = ADMIN_EMAILS.indexOf(email);
                        if (emailIndex !== -1) {
                            ADMIN_EMAILS.splice(emailIndex, 1);
                        }
                        return currentUser;
                    });
            }
            return currentUser;
        })
        .then((currentUser) => {
            return deleteUser(currentUser)
                .then(() => ({success: true, message: 'Account deleted successfully'}));
        })
        .catch(error => {
            console.error('Error in deleteUserAccount:', error);

            if (error.code === 'auth/wrong-password') {
                throw new Error('Incorrect password');
            } else if (error.code === 'auth/too-many-requests') {
                throw new Error('Too many attempts. Please try again later.');
            } else if (error.code === 'auth/requires-recent-login') {
                throw new Error('Please log out and log in again before deleting your account');
            }

            throw error;
        });
};
module.exports = {
    createUser,
    loginUser,
    forgotPassword,
    resetPassword,
    isUserAdmin,
    promoteUserToAdmin,
    ADMIN_EMAILS,
    loadAdminEmails,
    deleteUserAccount
};