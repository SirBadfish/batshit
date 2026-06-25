const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const logger = require('../utils/logger');

class CertificateService {
  constructor(config) {
    this.config = config;
    this.certDir = path.join(__dirname, '../../ssl');
    this.certPath = path.join(this.certDir, 'server.crt');
    this.keyPath = path.join(this.certDir, 'server.key');
  }

  async ensureCertificates() {
    // Use provided certificate paths if specified
    if (this.config.sslCertPath && this.config.sslKeyPath) {
      if (fs.existsSync(this.config.sslCertPath) && fs.existsSync(this.config.sslKeyPath)) {
        logger.info('Using provided SSL certificates');
        return {
          cert: fs.readFileSync(this.config.sslCertPath),
          key: fs.readFileSync(this.config.sslKeyPath)
        };
      } else {
        logger.warn('Provided SSL certificate paths not found, generating self-signed certificates');
      }
    }

    // Check if self-signed certificates already exist
    if (fs.existsSync(this.certPath) && fs.existsSync(this.keyPath)) {
      logger.info('Using existing self-signed certificates');
      return {
        cert: fs.readFileSync(this.certPath),
        key: fs.readFileSync(this.keyPath)
      };
    }

    // Generate new self-signed certificates
    if (this.config.autoGenerateCerts) {
      return this.generateSelfSignedCertificates();
    }

    throw new Error('HTTPS enabled but no certificates found and auto-generation disabled');
  }

  async generateSelfSignedCertificates() {
    logger.info('Generating self-signed certificates for HTTPS');

    const attrs = [
      { name: 'commonName', value: 'localhost' },
      { name: 'organizationName', value: 'batshit-server' },
      { name: 'countryName', value: 'US' }
    ];

    const options = {
      keySize: 2048,
      days: 365,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'basicConstraints',
          cA: false
        },
        {
          name: 'keyUsage',
          keyCertSign: false,
          digitalSignature: true,
          keyEncipherment: true
        },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 2, value: '127.0.0.1' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' }
          ]
        }
      ]
    };

    const pems = await selfsigned.generate(attrs, options);

    // Ensure SSL directory exists
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true });
    }

    // Write certificates to files
    fs.writeFileSync(this.certPath, pems.cert);
    fs.writeFileSync(this.keyPath, pems.private);

    logger.info('Self-signed certificates generated successfully');
    logger.warn('⚠️  Self-signed certificates are for development only!');
    logger.info('📋 To trust the certificate:');
    logger.info('   Chrome: Visit https://localhost:5443 and click "Advanced" -> "Proceed to localhost"');
    logger.info('   Firefox: Visit https://localhost:5443 and click "Advanced" -> "Accept the Risk"');
    logger.info('   Safari: Visit https://localhost:5443 and click "Show Details" -> "visit this website"');

    return {
      cert: pems.cert,
      key: pems.private
    };
  }
}

module.exports = CertificateService;
