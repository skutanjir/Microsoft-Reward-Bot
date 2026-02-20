import { chromium } from 'patchright'
import { FingerprintGenerator } from 'fingerprint-generator'
import { FingerprintInjector } from 'fingerprint-injector'
import fs from 'fs'

async function debugUI() {
    const browser = await chromium.launch({ headless: true })
    const fingerprintGenerator = new FingerprintGenerator()
    const fingerprintInjector = new FingerprintInjector()

    const fingerprint = fingerprintGenerator.getFingerprint({
        devices: ['desktop'],
        browsers: ['chrome'],
        operatingSystems: ['windows']
    })

    const context = await browser.newContext({
        userAgent: fingerprint.fingerprint.navigator.userAgent
    })

    await fingerprintInjector.attachFingerprintToPlaywright(context as any, fingerprint as any)

    const page = await context.newPage()

    // Load cookies from the first available desktop session
    const sessionsDir = 'sessions'
    if (fs.existsSync(sessionsDir)) {
        const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('_desktop.json'))
        if (sessionFiles.length > 0) {
            const sessionFile = sessionFiles[0]
            console.log(`Loading session from: ${sessionFile}`)
            const session = JSON.parse(fs.readFileSync(`${sessionsDir}/${sessionFile}`, 'utf-8'))
            await context.addCookies(session.cookies)
        } else {
            console.warn('No desktop session files found in sessions/')
        }
    }

    console.log('Navigating to Earn page...')
    await page.goto('https://rewards.bing.com/earn/', { waitUntil: 'networkidle' })

    console.log('Crawling for landmarks and cards...')
    const data = await page.evaluate(() => {
        const results: any[] = []

        // Find landmarks
        const landmarks = Array.from(document.querySelectorAll('h2, h3, span, div')).filter(el => {
            const text = el.textContent?.toLowerCase() || ''
            return text.includes('streak') || text.includes('quest') || text.includes('activity') || text.includes('level up')
        })

        landmarks.forEach((landmark: any) => {
            results.push({
                type: 'LANDMARK',
                tag: landmark.tagName,
                text: landmark.textContent?.substring(0, 50).trim(),
                classes: landmark.className,
                path: landmark.parentElement?.className
            })
        })

        // Find all clickable cards
        const clickable = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        clickable.forEach((el: any) => {
            if (el.textContent?.trim() || el.getAttribute('aria-label')) {
                results.push({
                    type: 'CLICKABLE',
                    tag: el.tagName,
                    text: el.textContent?.substring(0, 50).trim(),
                    classes: el.className,
                    aria: el.getAttribute('aria-label'),
                    bi: el.getAttribute('data-bi-id'),
                    parentClasses: el.parentElement?.className
                })
            }
        })

        return results
    })

    fs.writeFileSync('logs/ui_dump.json', JSON.stringify(data, null, 2))
    console.log(`Dumped ${data.length} elements. Data saved to logs/ui_dump.json`)

    await browser.close()
}

debugUI()
