/*jslint node: true, unparam: true, nomen: true */
(function () {
    'use strict';

    module.exports = function (globalConfig) {
        var lwip = require('pajk-lwip'),
            lodash = require('lodash'),
            async = require('async'),
            os = require('voilab-object-storage')(globalConfig),
            service = {

                /**
                 * Upload une image dans le cloud, sous plusieurs formats différents.
                 * La config est un objet de ce type:
                 * {
                 *   format: "prefix-<% =name %>-suffix", // le format du nom des images uploadée sur l'object storage. Utilise lodash.template().
                 *   omitExtension: true, // optionnel. Défaut: false. Si vrai, ne terminera pas automatiquement le nom de l'image par son extension.
                 *   files: [{
                 *     format: '', // optionnel. Prend le pas sur le format général ci-dessus.
                 *     name: 'nom-image-sans-id',
                 *     width: 100, // l'image originale est uploadée si omis
                 *     height: 80,
                 *     top: 10, // le crop est centré si omis
                 *     left: 5
                 *   }]
                 * }
                 *
                 * @param {multer} source le fichier uploadé capté par Multer
                 * @param {Array} config la configuration des uploads à faire
                 * @param {Function} cb
                 * @returns {void}
                 */
                upload: function (source, config, cb) {
                    var type = source && source.mimetype && source.mimetype.replace('image/', ''),
                        tasks = [],
                        images = {},
                        default_format = config.format || '';

                    if (lodash.isString(source)) {
                        type = source.split('.').pop();
                    }

                    if (!type) {
                        return cb(new Error("Image doesn't have any type (jpg, png, etc.)!"));
                    }
                    if (config.files === undefined || !lodash.isArray(config.files)) {
                        return cb(new Error("Image upload configuration must contain a 'files' array."));
                    }

                    lodash.forEach(config.files, function (c) {
                        var string_or_buffer = lodash.isString(source) ? source : new Buffer(source.buffer);
                        tasks.push(function (callback) {
                            lwip.open(string_or_buffer, type, function (err, image) {
                                if (err) {
                                    return callback(err);
                                }
                                var dim = null,
                                    width = c.width || false,
                                    height = c.height || false,
                                    crop_top = c.top || 0,
                                    crop_left = c.left || 0,
                                    batch = image.batch(),
                                    colorPad = c.colorPad || config.colorPad || 'white';

                                // si ni largeur, ni hauteur ne sont fournie, on ne redimmensionne pas l'image
                                if (width || height) {
                                    // si les 2 dimensions sont données, il faudra soit croper, soit adapter l'image au rectangle défini par largeur x hauteur
                                    if (width && height) {
                                        if (c.crop) {
                                            // si on souhaite adapter l'image avant de la redimmensionner en vue d'un crop
                                            if (c.adapt) {
                                                if (lodash.isObject(c.adapt) && c.adapt.width && c.adapt.height) {
                                                    batch.contain(c.adapt.width, c.adapt.height, colorPad);
                                                } else if (lodash.isBoolean(c.adapt)) {
                                                    batch.contain(Math.max(width, height), Math.max(width, height), colorPad);
                                                } else {
                                                    batch.contain(c.adapt, c.adapt, colorPad);
                                                }
                                            } else {
                                                dim = service.getCropDimensions(image, width, height);
                                                batch.resize(dim.width, dim.height); // l'image sera cropée par la suite
                                            }
                                        } else {
                                            dim = service.adaptDimensions(image, width, height);
                                            batch.resize(dim.width, dim.height);
                                        }

                                        // Si on n'a qu'une des 2 dimensions, on redimmensionne l'image en fonction de la dimension fournie
                                    } else {
                                        if (!height) {
                                            dim = service.getDimensionsWidthMax(image, width);
                                        } else {
                                            dim = service.getDimensionsHeightMax(image, height);
                                        }
                                        batch.resize(dim.width, dim.height);
                                    }

                                    // crop centré ou non de l'image
                                    if (c.crop) {
                                        if (crop_top > 0 || crop_left > 0) {
                                            batch.crop(crop_left, crop_top, crop_left + width, crop_top + height);
                                        } else {
                                            batch.crop(width, height);
                                        }
                                    }
                                }

                                // récup du buffer temporaire avant envoi sur le cloud
                                batch.toBuffer(type, function (err, buffer) {
                                    if (err) {
                                        return callback(err);
                                    }
                                    // renvoi du chemin vers la nouvelle image
                                    var compiled = lodash.template(c.format || default_format),
                                        omit_ext = (c.omitExtension || config.omitExtension || false),
                                        filename = compiled(c) + (omit_ext ? '' : ('.' + type));
                                    os.uploadFromBuffer(buffer, filename, function (err, path) {
                                        if (err) {
                                            return callback(err);
                                        }
                                        images[c.key || c.name] = {
                                            url: globalConfig.staticUrl + path,
                                            filename: filename
                                        };
                                        callback(null);
                                    });
                                });
                            });
                        });
                    });
                    async.parallelLimit(tasks, (globalConfig.resizeLimit || 8), function (err) {
                        if (err) {
                            return cb(err);
                        }
                        cb(null, images);
                    });
                },

                getCropDimensions: function (image, width, height) {
                    // calcule automatiquement la hauteur en fonction de la largeur
                    // si aucune hauteur spécifique n'est définie (et vice-versa)
                    var ratio_img = image.width() / image.height(),
                        ratio_crop = width / height,
                        h = 0,
                        w = 0;

                    if (ratio_img > ratio_crop) {
                        h = height;
                        w = h * ratio_img;
                    } else {
                        w = width;
                        h = w / ratio_img;
                    }

                    return {
                        width: Math.round(w),
                        height: Math.round(h)
                    };
                },

                /**
                 * Adaptation des dimensions de l'image en fonction du rectangle donné (width et height)
                 *
                 * @param image
                 * @param width
                 * @param height
                 * @returns {{width: number, height: number}}
                 */
                adaptDimensions: function (image, width, height) {
                    var container_ratio = width / height,
                        img_ratio = image.width() / image.height();

                    // le ratio du container est plus important que celui de l'image
                    // cela signifie qu'il faut se concentrer sur la hauteur de l'image.
                    // Si la hauteur passe, la largeur passera.
                    if (container_ratio > img_ratio) {
                        if (image.height() < height) {
                            height = image.height();
                            width = image.width();
                        }
                        if (image.height() > height) {
                            width = image.width() * height / image.height();
                        }
                    } else {
                        if (image.width() < width) {
                            width = image.width();
                            height = image.height();
                        }
                        if (image.width() >= width) {
                            height = image.height() * width / image.width();
                        }
                    }

                    return {
                        width: Math.round(width),
                        height: Math.round(height)
                    };
                },

                getDimensionsWidthMax: function (image, width) {
                    var height = (image.height() * width) / image.width();
                    if (height > image.height()) {
                        width = image.width();
                        height = image.height();
                    }
                    return {
                        width: Math.round(width),
                        height: Math.round(height)
                    };
                },

                getDimensionsHeightMax: function (image, height) {
                    var width = (image.width() * height) / image.height();
                    if (width > image.width()) {
                        height = image.height();
                        width = image.width();
                    }
                    return {
                        width: Math.round(width),
                        height: Math.round(height)
                    };
                }
            };

        return service;
    };
}());
