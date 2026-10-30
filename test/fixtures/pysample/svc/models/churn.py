from config import PORT
import config


class Model:
    def train(self):
        return PORT + config.DEBUG

    def predict(self):
        def inner():
            return 1
        return inner()
