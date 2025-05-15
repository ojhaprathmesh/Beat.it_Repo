const {db, storage} = require('./firebaseConfig');
const {collection, doc, setDoc, getDocs, writeBatch} = require('firebase/firestore');
const {ref, uploadBytes, getDownloadURL} = require('firebase/storage');
const fs = require('fs');
const path = require('path');

/**
 * Add a single song to Firestore
 */
const addSong = async (songData) => {
    try {
        await setDoc(doc(db, 'songs', songData.id.toString()), {
            id: songData.id,
            title: songData.title,
            artist: songData.artist,
            album: songData.album,
            genre: songData.genre,
            file: songData.file,
            albumCover: songData.albumCover,
            duration: songData.duration
        });
        return true;
    } catch (error) {
        console.error('Error adding song to Firestore:', error);
        throw error;
    }
};

/**
 * Migrate all songs to Firestore in a batch
 */
const migrateSongs = async (songs) => {
    try {
        const batch = writeBatch(db);

        for (const song of songs) {
            const songRef = doc(db, 'songs', song.id.toString());
            batch.set(songRef, {
                id: song.id,
                title: song.title,
                artist: song.artist,
                album: song.album,
                genre: song.genre,
                file: song.file,
                albumCover: song.albumCover,
                duration: song.duration
            });
        }

        await batch.commit();
        console.log('Songs migrated to Firestore successfully');
        return true;
    } catch (error) {
        console.error('Error migrating songs to Firestore:', error);
        throw error;
    }
};

/**
 * Get all songs from Firestore
 */
const getAllSongs = async () => {
    try {
        const songsSnapshot = await getDocs(collection(db, 'songs'));
        const songs = [];

        songsSnapshot.forEach(doc => {
            songs.push(doc.data());
        });

        return songs;
    } catch (error) {
        console.error('Error getting songs from Firestore:', error);
        throw error;
    }
};

/**
 * Upload an audio file to Firebase Storage
 */
const uploadSongFile = async (filePath, fileName) => {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const storageRef = ref(storage, `songs/${fileName}`);

        // Upload the file
        const snapshot = await uploadBytes(storageRef, fileBuffer, {
            contentType: 'audio/mpeg',
        });

        // Get the download URL
        return await getDownloadURL(snapshot.ref);
    } catch (error) {
        console.error('Error uploading song file to Firebase Storage:', error);
        throw error;
    }
};

/**
 * Migrate all song files from local storage to Firebase Storage
 */
const migrateSongFiles = async () => {
    try {
        const songs = await getAllSongs();
        const songsDir = path.join(__dirname, '../../frontend/public/uploads');
        const batch = writeBatch(db);

        for (const song of songs) {
            const fileName = song.file.split('/').pop(); // Extract filename from the path
            const localFilePath = path.join(songsDir, fileName);

            if (fs.existsSync(localFilePath)) {
                // Upload the file to Firebase Storage
                const downloadURL = await uploadSongFile(localFilePath, fileName);

                // Update the song document with new URL
                const songRef = doc(db, 'songs', song.id.toString());
                batch.update(songRef, {file: downloadURL});
            }
        }

        await batch.commit();
        console.log('Song files migrated to Firebase Storage successfully');
        return true;
    } catch (error) {
        console.error('Error migrating song files:', error);
        throw error;
    }
};

/**
 * Export all songs to a JSON file for front-end use
 */
const exportSongsToJSON = async () => {
    try {
        const songs = await getAllSongs();
        const filePath = path.join(__dirname, '../../frontend/public/data/songsData.json');

        fs.writeFileSync(filePath, JSON.stringify(songs, null, 2));
        console.log(`Songs data exported to ${filePath}`);
        return filePath;
    } catch (error) {
        console.error('Error exporting songs to JSON:', error);
        throw error;
    }
};

module.exports = {
    addSong, migrateSongs, getAllSongs,
    uploadSongFile, migrateSongFiles, exportSongsToJSON
}; 