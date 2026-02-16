#!/usr/bin/env node

/**
 * Save Quest Script
 *
 * After using quest-builder.html, run this to save your quest:
 *   node save-quest.js
 *
 * It will prompt you for:
 * 1. Quest name
 * 2. Path to exported HTML file
 * 3. Paths to image files
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise(resolve => {
        rl.question(prompt, resolve);
    });
}

async function main() {
    console.log('\n⚔️  Quest Builder - File Saver\n');
    console.log('This script saves your quest files to the correct locations.\n');

    // Get quest name
    const questName = await question('Quest name (e.g., Episode One): ');
    const questSlug = questName.toLowerCase().replace(/\s+/g, '-');

    // Create directories
    const questDir = path.join(__dirname, 'quests', questSlug);
    const imagesDir = path.join(questDir, 'images');

    if (!fs.existsSync(questDir)) {
        fs.mkdirSync(questDir, { recursive: true });
        console.log(`✅ Created: ${questDir}`);
    }

    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
        console.log(`✅ Created: ${imagesDir}`);
    }

    // Get HTML file path
    const htmlPath = await question('\nPath to your HTML file: ');

    if (!fs.existsSync(htmlPath)) {
        console.error('❌ HTML file not found!');
        rl.close();
        return;
    }

    // Copy HTML file
    const htmlFileName = `${questSlug}.html`;
    const questHtmlPath = path.join(questDir, htmlFileName);

    fs.copyFileSync(htmlPath, questHtmlPath);
    console.log(`✅ Saved HTML: ${questHtmlPath}`);

    // Handle images
    console.log('\n📷 Image Files (optional)');
    console.log('You can now add images to your quest.\n');

    let addMoreImages = true;
    const copiedImages = [];

    while (addMoreImages) {
        const imagePath = await question('Image file path (or press Enter to skip): ');

        if (!imagePath.trim()) {
            addMoreImages = false;
            break;
        }

        if (!fs.existsSync(imagePath)) {
            console.error('❌ Image file not found:', imagePath);
            continue;
        }

        const imageName = path.basename(imagePath);
        const destPath = path.join(imagesDir, imageName);

        fs.copyFileSync(imagePath, destPath);
        console.log(`✅ Copied: ${imageName}`);
        copiedImages.push(imageName);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✨ Quest Created Successfully!\n');
    console.log('📁 Quest Location:');
    console.log(`   ${questDir}\n`);
    console.log('📄 Files Created:');
    console.log(`   • ${questHtmlPath}`);
    if (copiedImages.length > 0) {
        copiedImages.forEach(img => {
            console.log(`   • ${path.join(imagesDir, img)}`);
        });
    }
    console.log('\n🚀 Next Steps:');
    console.log('   1. Open your quest in a browser:');
    console.log(`      file://${questHtmlPath}\n`);
    console.log('   2. Test all paths and interactions');
    console.log('   3. Add a link in enter.html to access your quest');
    console.log('\n' + '='.repeat(60) + '\n');

    rl.close();
}

main().catch(console.error);
